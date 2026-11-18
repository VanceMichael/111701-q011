import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PortalRejectionError,
  PortalTimeoutError,
  RegistrationStatus,
  ReviewReason,
  registrationKey,
} from '../src/registration-model.mjs';
import { RegistrationStore } from '../src/registration-store.mjs';
import { RegistrationService } from '../src/registration-service.mjs';

const STUDENT = { id: 'S-1001', name: '张三' };
const OFFERING = 'course-2026-A';

function receiptFor(registration, overrides = {}) {
  return {
    receiptId: 'R-0001',
    studentId: registration.student.id,
    offeringId: registration.offeringId,
    status: 'accepted',
    ...overrides,
  };
}

async function withStore(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'registrations-'));
  try {
    const store = await RegistrationStore.open({ dir });
    return await fn(store, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function countingPortal(handler) {
  const calls = [];
  return {
    calls,
    async submit(registration) {
      calls.push(registration);
      return handler(registration, calls.length);
    },
  };
}

test('回执超时把报名留在核对队列，不伪装成功也不自动重提', async () => {
  await withStore(async (store) => {
    const portal = countingPortal(() => {
      throw new PortalTimeoutError('门户 30s 未返回回执');
    });
    const service = new RegistrationService({ store, portal, receiptTimeoutMs: 50 });
    const opened = await service.open({ student: STUDENT, offeringId: OFFERING, draft: { name: '张三' } });

    const first = await service.submit(opened.id);
    assert.equal(first.outcome, 'needs_review');
    assert.equal(first.registration.status, RegistrationStatus.UNCERTAIN);
    assert.equal(first.registration.requiresReview, true);
    assert.equal(first.registration.reviewReason, ReviewReason.RECEIPT_TIMEOUT);
    assert.equal(first.registration.confirmedAt, null);
    assert.equal(portal.calls.length, 1);

    // 重复调用只能是“还是待核对”，不能再碰门户。
    const second = await service.submit(opened.id);
    assert.equal(second.outcome, 'needs_review');
    assert.equal(second.submitted, false);
    assert.equal(portal.calls.length, 1);

    assert.deepEqual(
      service.reviewQueue().map((registration) => registration.id),
      [opened.id],
    );
  });
});

test('超时后重新进入同一学员同一班期，不会产生第二份报名', async () => {
  await withStore(async (store) => {
    const portal = countingPortal(() => {
      throw new PortalTimeoutError();
    });
    const service = new RegistrationService({ store, portal, receiptTimeoutMs: 20 });

    const first = await service.open({ student: STUDENT, offeringId: OFFERING });
    await service.submit(first.id);

    const reopened = await service.open({
      student: { studentId: 'S-1001' },
      offeringId: OFFERING,
      draft: { phone: '13800000000' },
    });
    assert.equal(reopened.id, first.id);
    assert.equal(reopened.requiresReview, true);
    // 待核对的进度不会被新草稿覆盖。
    assert.deepEqual(reopened.draft, {});
    assert.equal(service.status(first.id).attempts, 1);

    const retried = await service.submit(first.id);
    assert.equal(retried.submitted, false);
    assert.equal(portal.calls.length, 1);
  });
});

test('多步表单的进度逐步落盘，失败后从断点继续', async () => {
  await withStore(async (store, dir) => {
    const service = new RegistrationService({
      store,
      portal: countingPortal(() => {
        throw new PortalTimeoutError();
      }),
      receiptTimeoutMs: 20,
    });
    const registration = await service.open({ student: STUDENT, offeringId: OFFERING });
    await service.saveDraft(registration.id, { step1: { name: '张三' } });

    // 模拟进程退出后重新打开。
    const reopenedStore = await RegistrationStore.open({ dir });
    const resumed = reopenedStore.get(registration.id);
    assert.deepEqual(resumed.draft, { step1: { name: '张三' } });

    await reopenedStore.saveDraft(registration.id, { step2: { phone: '138' } });
    assert.deepEqual(reopenedStore.get(registration.id).draft, {
      step1: { name: '张三' },
      step2: { phone: '138' },
    });
    // undefined 只是“这步没填”，不会抹掉已完成步骤。
    await reopenedStore.saveDraft(registration.id, { step3: undefined, step2: { phone: '139' } });
    assert.deepEqual(reopenedStore.get(registration.id).draft.step2, { phone: '139' });
  });
});

test('进程在提交途中退出：重启后自动转入核对，绝不再次提交', async () => {
  await withStore(async (store, dir) => {
    const registration = await store.ensureRegistration({ student: STUDENT, offeringId: OFFERING });
    await store.beginSubmission(registration.id);

    const onDisk = JSON.parse(await readFile(join(dir, 'registrations.json'), 'utf8'));
    assert.equal(onDisk.registrations[0].status, RegistrationStatus.SUBMITTING);

    const restarted = await RegistrationStore.open({ dir });
    const recovered = restarted.get(registration.id);
    assert.equal(recovered.status, RegistrationStatus.UNCERTAIN);
    assert.equal(recovered.requiresReview, true);
    assert.equal(recovered.reviewReason, ReviewReason.PROCESS_INTERRUPTED);

    const portal = countingPortal(() => {
      throw new Error('不应接触门户');
    });
    const service = new RegistrationService({ store: restarted, portal });
    const result = await service.submit(registration.id);
    assert.equal(result.submitted, false);
    assert.equal(portal.calls.length, 0);
  });
});

test('并发提交同一份报名只有一个请求到达门户', async () => {
  await withStore(async (store) => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const portal = countingPortal(async (registration) => {
      await gate;
      return receiptFor(registration);
    });
    const service = new RegistrationService({ store, portal, receiptTimeoutMs: 1000 });
    const registration = await service.open({ student: STUDENT, offeringId: OFFERING });

    const first = service.submit(registration.id);
    const second = await service.submit(registration.id);
    assert.equal(second.submitted, false);
    assert.equal(second.outcome, 'in_flight');
    release();
    const settled = await first;
    // 第二次调用看到 submitting 后只报告“进行中/待核对”，不会再发一次。
    assert.equal(portal.calls.length, 1);
    assert.equal(settled.outcome, 'confirmed');
    assert.equal(settled.registration.status, RegistrationStatus.CONFIRMED);
  });
});

test('回执通过学员身份和班期关联到正确报名', async () => {
  await withStore(async (store) => {
    const portal = countingPortal((registration) =>
      receiptFor(registration, { receiptId: 'R-42', confirmedAt: '2026-11-18T01:00:00.000Z' }),
    );
    const service = new RegistrationService({ store, portal });
    const opened = await service.open({ student: STUDENT, offeringId: OFFERING });

    const result = await service.submit(opened.id);
    assert.equal(result.outcome, 'confirmed');
    assert.equal(result.registration.status, RegistrationStatus.CONFIRMED);
    assert.equal(result.registration.confirmedAt, '2026-11-18T01:00:00.000Z');
    assert.equal(result.registration.receipts.length, 1);
    assert.equal(result.registration.receipts[0].registrationKey, registrationKey('S-1001', OFFERING));

    // 已确认后重复调用不会重复提交，也不会丢掉回执。
    const again = await service.submit(opened.id);
    assert.equal(again.submitted, false);
    assert.equal(again.registration.receipts[0].receiptId, 'R-42');
    assert.equal(portal.calls.length, 1);
  });
});

test('对不上人或班期的回执不确认，留在待核对', async () => {
  await withStore(async (store) => {
    const portal = countingPortal((registration) =>
      receiptFor(registration, { studentId: 'S-9999' }),
    );
    const service = new RegistrationService({ store, portal });
    const opened = await service.open({ student: STUDENT, offeringId: OFFERING });

    const result = await service.submit(opened.id);
    assert.equal(result.outcome, 'needs_review');
    assert.equal(result.registration.status, RegistrationStatus.UNCERTAIN);
    assert.equal(result.registration.reviewReason, ReviewReason.RECEIPT_MISMATCH);
    assert.equal(result.registration.confirmedAt, null);

    // 无关联信息的回执同样不能算成功。
    const anonymous = await store.confirm(opened.id, { receiptId: 'R-匿名' });
    assert.equal(anonymous.requiresReview, true);
    assert.equal(anonymous.reviewReason, ReviewReason.RECEIPT_INCOMPLETE);
  });
});

test('同一条回执不能确认两份报名', async () => {
  await withStore(async (store) => {
    const portal = countingPortal((registration) =>
      receiptFor(registration, { receiptId: 'R-DUP' }),
    );
    const service = new RegistrationService({ store, portal });

    const first = await service.open({ student: STUDENT, offeringId: OFFERING });
    const second = await service.open({ student: { id: 'S-2002' }, offeringId: OFFERING });

    assert.equal((await service.submit(first.id)).outcome, 'confirmed');
    const secondResult = await service.submit(second.id);
    assert.equal(secondResult.outcome, 'needs_review');
    assert.equal(secondResult.registration.reviewReason, ReviewReason.RECEIPT_CONFLICT);
  });
});

test('门户一直不回执：超时后转为待核对，且不再重复访问门户', async () => {
  await withStore(async (store) => {
    let aborted = false;
    const portal = {
      calls: 0,
      submit(registration, { signal }) {
        this.calls += 1;
        signal?.addEventListener('abort', () => {
          aborted = true;
        });
        return new Promise(() => {
          // 永不返回，模拟门户已经收表但回执丢失。
        });
      },
    };
    const service = new RegistrationService({ store, portal, receiptTimeoutMs: 20 });
    const opened = await service.open({ student: STUDENT, offeringId: OFFERING });
    await service.saveDraft(opened.id, { step1: { name: '张三' }, step2: { phone: '138' } });

    const result = await service.submit(opened.id);
    assert.equal(result.outcome, 'needs_review');
    assert.equal(result.registration.reviewReason, ReviewReason.RECEIPT_TIMEOUT);
    assert.equal(aborted, true);
    assert.deepEqual(result.registration.draft, {
      step1: { name: '张三' },
      step2: { phone: '138' },
    });

    const again = await service.submit(opened.id);
    assert.equal(again.submitted, false);
    assert.equal(portal.calls, 1);
  });
});

test('门户明确拒绝可以安全重新提交，且不会累积待核对', async () => {
  await withStore(async (store) => {
    let attempt = 0;
    const portal = countingPortal((registration) => {
      attempt += 1;
      if (attempt === 1) throw new PortalRejectionError('名额已满');
      return receiptFor(registration);
    });
    const service = new RegistrationService({ store, portal });
    const opened = await service.open({ student: STUDENT, offeringId: OFFERING });

    const rejected = await service.submit(opened.id);
    assert.equal(rejected.outcome, 'rejected');
    assert.equal(rejected.registration.status, RegistrationStatus.REJECTED);
    assert.equal(rejected.registration.requiresReview, false);

    const confirmed = await service.submit(opened.id);
    assert.equal(confirmed.outcome, 'confirmed');
    assert.equal(confirmed.registration.attempts, 2);
    assert.equal(service.reviewQueue().length, 0);
  });
});

test('运营核对两种收口都需要回执或依据，核对记录可追溯', async () => {
  await withStore(async (store) => {
    const portal = countingPortal(() => {
      throw new PortalTimeoutError();
    });
    const service = new RegistrationService({ store, portal, receiptTimeoutMs: 20 });
    const opened = await service.open({ student: STUDENT, offeringId: OFFERING });
    await service.submit(opened.id);

    await assert.rejects(
      service.resolve(opened.id, { outcome: 'confirmed', checkedBy: '李老师' }),
      /依据/,
    );
    await assert.rejects(
      service.resolve(opened.id, { outcome: 'confirmed', checkedBy: '李老师', note: '查询门户' }),
      /回执/,
    );
    await assert.rejects(
      service.resolve(opened.id, {
        outcome: 'confirmed',
        checkedBy: '李老师',
        note: '查询门户',
        receipt: { receiptId: 'R-OTHER', studentId: 'S-9999', offeringId: OFFERING },
      }),
      /不一致/,
    );

    // 核对后确认：附上门户补发的回执。
    const resolved = await service.resolve(opened.id, {
      outcome: 'confirmed',
      checkedBy: '李老师',
      note: '门户后台查询到报名号',
      receipt: receiptFor(opened),
    });
    assert.equal(resolved.status, RegistrationStatus.CONFIRMED);
    assert.equal(resolved.requiresReview, false);
    assert.equal(resolved.resolution.by, '李老师');
    assert.equal(resolved.resolution.note, '门户后台查询到报名号');
    assert.equal(resolved.receipts.at(-1).receiptId, 'R-0001');
    assert.equal(service.reviewQueue().length, 0);
  });
});

test('核对为未报名后，报名回到可重新提交状态', async () => {
  await withStore(async (store) => {
    let attempt = 0;
    const portal = countingPortal((registration) => {
      attempt += 1;
      if (attempt === 1) throw new PortalTimeoutError();
      return receiptFor(registration);
    });
    const service = new RegistrationService({ store, portal, receiptTimeoutMs: 20 });
    const opened = await service.open({ student: STUDENT, offeringId: OFFERING });
    await service.submit(opened.id);
    assert.equal(service.reviewQueue().length, 1);

    await assert.rejects(
      service.resolve(opened.id, { outcome: 'not_accepted', checkedBy: '李老师', note: '' }),
      /依据/,
    );
    const resolved = await service.resolve(opened.id, {
      outcome: 'not_accepted',
      checkedBy: '李老师',
      note: '门户无此报名记录，名额未占用',
    });
    assert.equal(resolved.status, RegistrationStatus.NOT_ACCEPTED);
    assert.equal(resolved.confirmedAt, null);

    const retried = await service.submit(opened.id);
    assert.equal(retried.outcome, 'confirmed');
    assert.equal(portal.calls.length, 2);
  });
});

test('已确认的报名重新进入时原样返回，不被新草稿改写', async () => {
  await withStore(async (store) => {
    const portal = countingPortal((registration) => receiptFor(registration));
    const service = new RegistrationService({ store, portal });
    const opened = await service.open({ student: STUDENT, offeringId: OFFERING });
    await service.submit(opened.id);

    const reopened = await service.open({
      student: STUDENT,
      offeringId: OFFERING,
      draft: { step1: { name: '改过的名字' } },
    });
    assert.equal(reopened.status, RegistrationStatus.CONFIRMED);
    assert.deepEqual(reopened.draft, {});
    assert.equal(portal.calls.length, 1);
  });
});

test('迟到的回执可以在核对时补录，且必须能对上这份报名', async () => {
  await withStore(async (store) => {
    const portal = countingPortal(() => {
      throw new PortalTimeoutError();
    });
    const service = new RegistrationService({ store, portal, receiptTimeoutMs: 20 });
    const opened = await service.open({ student: STUDENT, offeringId: OFFERING });
    const timedOut = await service.submit(opened.id);
    assert.equal(timedOut.registration.requiresReview, true);

    // 对不上的迟到回执不会收口。
    const mismatched = await service.recordReceipt(
      opened.id,
      receiptFor({ student: { id: 'S-9999' }, offeringId: OFFERING }, { receiptId: 'R-LATE-1' }),
    );
    assert.equal(mismatched.requiresReview, true);

    // 对得上的迟到回执才确认。
    const late = await service.recordReceipt(opened.id, receiptFor(opened, { receiptId: 'R-LATE-2' }));
    assert.equal(late.status, RegistrationStatus.CONFIRMED);
    assert.equal(late.requiresReview, false);
    assert.equal(late.receipts.at(-1).receiptId, 'R-LATE-2');
    assert.equal(service.reviewQueue().length, 0);
  });
});

test('无法识别的回执状态不会被当成成功', async () => {
  await withStore(async (store) => {
    const portal = countingPortal((registration) =>
      receiptFor(registration, { status: 'queued-for-manual-check' }),
    );
    const service = new RegistrationService({ store, portal });
    const opened = await service.open({ student: STUDENT, offeringId: OFFERING });

    const result = await service.submit(opened.id);
    assert.equal(result.outcome, 'needs_review');
    assert.equal(result.registration.reviewReason, ReviewReason.UNRECOGNIZED_RECEIPT);
    assert.equal(result.registration.confirmedAt, null);
  });
});

test('适配器抛出未预期错误同样按结果未知处理', async () => {
  await withStore(async (store) => {
    const portal = countingPortal(() => {
      throw new TypeError('响应格式错误');
    });
    const service = new RegistrationService({ store, portal });
    const opened = await service.open({ student: STUDENT, offeringId: OFFERING });

    const result = await service.submit(opened.id);
    assert.equal(result.outcome, 'needs_review');
    assert.equal(result.registration.reviewReason, ReviewReason.PORTAL_ERROR);
    assert.equal(result.registration.requiresReview, true);
  });
});

test('核对为未报名后又收到确认回执：冲突交回核对，不悄悄改判', async () => {
  await withStore(async (store) => {
    const portal = countingPortal(() => {
      throw new PortalTimeoutError();
    });
    const service = new RegistrationService({ store, portal, receiptTimeoutMs: 20 });
    const opened = await service.open({ student: STUDENT, offeringId: OFFERING });
    await service.submit(opened.id);
    await service.resolve(opened.id, {
      outcome: 'not_accepted',
      checkedBy: '李老师',
      note: '门户无记录',
    });

    const conflict = await service.recordReceipt(opened.id, receiptFor(opened));
    assert.equal(conflict.status, RegistrationStatus.UNCERTAIN);
    assert.equal(conflict.requiresReview, true);
    assert.equal(conflict.reviewReason, ReviewReason.RECEIPT_CONFLICT);
    assert.equal(conflict.confirmedAt, null);
    assert.equal(conflict.resolutionHistory.length, 1);
    assert.equal(conflict.resolutionHistory[0].by, '李老师');
    assert.equal(service.reviewQueue().length, 1);
  });
});

test('待核对的报名在结论落定前不能覆盖草稿', async () => {
  await withStore(async (store) => {
    const service = new RegistrationService({
      store,
      portal: countingPortal(() => {
        throw new PortalTimeoutError();
      }),
      receiptTimeoutMs: 20,
    });
    const opened = await service.open({ student: STUDENT, offeringId: OFFERING });
    await service.submit(opened.id);
    await assert.rejects(service.saveDraft(opened.id, { step2: { phone: '1' } }), /待核对/);
  });
});
