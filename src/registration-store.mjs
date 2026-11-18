import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  RegistrationError,
  RegistrationStatus,
  ReviewReason,
  canSubmitRegistration,
  normalizeDraft,
  normalizeReceipt,
  normalizeStudent,
  registrationIdForKey,
  registrationKey,
} from './registration-model.mjs';

/**
 * 单份报名的可持久化进度。
 *
 * 关键不变式：
 * - 只有 confirmed 的报名带有效回执；其他状态一律不能被当成“已报上”。
 * - requiresReview 为真时只能由运营核对收口，不能再提交。
 * - 每次写入先落临时文件再 rename，崩溃不会留下半截进度。
 */
export class RegistrationStore {
  #dir;
  #registrations = new Map();
  #byKey = new Map();
  #byReceipt = new Map();
  #loaded = false;
  #writeChain = Promise.resolve();

  constructor({ dir = null } = {}) {
    this.#dir = dir ? resolve(dir) : null;
  }

  static async open({ dir } = {}) {
    if (!dir) throw new RegistrationError('INVALID_STORE_DIR', '持久化目录不能为空');
    const store = new RegistrationStore({ dir });
    await store.load();
    return store;
  }

  get dir() {
    return this.#dir;
  }

  /**
   * 从磁盘恢复进度。恢复时仍停留在 submitting 的报名说明上个进程在
   * 回执返回前退出了：结果只能未知，因此立即转入运营核对，绝不自动重提。
   */
  async load() {
    if (!this.#dir) {
      this.#loaded = true;
      return this;
    }
    await mkdir(this.#dir, { recursive: true });
    let text;
    try {
      text = await readFile(this.#path(), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.#loaded = true;
        return this;
      }
      throw error;
    }
    let snapshot;
    try {
      snapshot = JSON.parse(text);
    } catch (error) {
      throw new RegistrationError('CORRUPT_STORE', '报名进度文件无法解析', {
        path: this.#path(),
        cause: error.message,
      });
    }
    this.#registrations.clear();
    this.#byKey.clear();
    this.#byReceipt.clear();
    for (const registration of snapshot?.registrations ?? []) {
      this.#index(structuredClone(registration));
    }
    this.#loaded = true;

    const interrupted = [...this.#registrations.values()].filter(
      (registration) => registration.status === RegistrationStatus.SUBMITTING,
    );
    for (const registration of interrupted) {
      await this.#commit({
        ...registration,
        status: RegistrationStatus.UNCERTAIN,
        requiresReview: true,
        reviewReason: ReviewReason.PROCESS_INTERRUPTED,
        reviewDetail: '上次提交在回执返回前中断，需向门户核对名额',
        updatedAt: new Date().toISOString(),
      });
    }
    return this;
  }

  /**
   * 取出（或新建）一份报名。重复调用不会产生第二份进度。
   * 已有报名无论处于提交中、待核对还是已确认，都原样返回（不覆盖草稿）。
   */
  async ensureRegistration({ student, offeringId } = {}) {
    const normalizedStudent = normalizeStudent(student);
    const key = registrationKey(normalizedStudent.id, offeringId);
    const existing = this.#byKey.get(key);
    if (existing) return structuredClone(existing);

    const now = new Date().toISOString();
    const normalizedOffering = String(offeringId).trim();
    const registration = {
      id: registrationIdForKey(key),
      version: 0,
      registrationKey: key,
      student: normalizedStudent,
      offeringId: normalizedOffering,
      status: RegistrationStatus.DRAFT,
      requiresReview: false,
      reviewReason: null,
      reviewDetail: null,
      attempts: 0,
      lastError: null,
      lastErrorDetail: null,
      receipts: [],
      draft: {},
      draftUpdatedAt: now,
      submittedAt: null,
      confirmedAt: null,
      resolvedAt: null,
      resolution: null,
      resolutionHistory: [],
      createdAt: now,
      updatedAt: now,
    };
    return structuredClone(await this.#commit(registration));
  }

  get(registrationId) {
    const found = this.#registrations.get(registrationId);
    return found ? structuredClone(found) : null;
  }

  list({ status, requiresReview } = {}) {
    return [...this.#registrations.values()]
      .filter((registration) => status === undefined || registration.status === status)
      .filter(
        (registration) =>
          requiresReview === undefined || registration.requiresReview === requiresReview,
      )
      .map((registration) => structuredClone(registration));
  }

  pendingReview() {
    return this.list({ requiresReview: true }).sort((a, b) =>
      a.updatedAt.localeCompare(b.updatedAt),
    );
  }

  /**
   * 分步表单在失败时可能只填了一部分。每一步都先保存，重进时接着填，
   * 而不是从头再提交一份。
   */
  async saveDraft(registrationId, draftPatch) {
    if (!draftPatch || typeof draftPatch !== 'object' || Array.isArray(draftPatch)) {
      throw new RegistrationError('INVALID_DRAFT', '报名草稿必须是对象');
    }
    const current = this.#require(registrationId);
    if (current.status === RegistrationStatus.CONFIRMED) {
      throw new RegistrationError('ALREADY_CONFIRMED', '报名已确认，不能再修改草稿');
    }
    if (current.requiresReview) {
      throw new RegistrationError('REVIEW_PENDING', '报名待核对，不能用草稿覆盖进度', {
        registrationId,
        reviewReason: current.reviewReason,
      });
    }
    if (current.status === RegistrationStatus.SUBMITTING) {
      throw new RegistrationError('SUBMISSION_IN_FLIGHT', '报名正在提交，不能修改草稿', {
        registrationId,
      });
    }
    const now = new Date().toISOString();
    return structuredClone(
      await this.#commit({
        ...current,
        draft: { ...current.draft, ...normalizeDraft(draftPatch) },
        draftUpdatedAt: now,
        updatedAt: now,
      }),
    );
  }

  /**
   * 提交前把报名标成 submitting 并落盘。这是防重复的关键：
   * 即使进程在此刻崩溃，重启后看到的是“提交结果未知”，而不是一份可再次提交的草稿。
   * 前置条件不满足时直接拒绝，不会触碰门户。
   */
  async beginSubmission(registrationId) {
    const current = this.#require(registrationId);
    if (!canSubmitRegistration(current)) {
      const code =
        current.status === RegistrationStatus.SUBMITTING
          ? 'SUBMISSION_IN_FLIGHT'
          : current.status === RegistrationStatus.CONFIRMED
            ? 'ALREADY_CONFIRMED'
            : current.requiresReview
              ? 'REVIEW_PENDING'
              : 'INVALID_STATE';
      throw new RegistrationError(code, '当前进度不允许再次提交', {
        registrationId,
        status: current.status,
      });
    }
    const now = new Date().toISOString();
    return structuredClone(
      await this.#commit({
        ...current,
        status: RegistrationStatus.SUBMITTING,
        attempts: current.attempts + 1,
        lastError: null,
        lastErrorDetail: null,
        submittedAt: now,
        updatedAt: now,
      }),
    );
  }

  /**
   * 回执只有在能被识别、且清楚指向这份报名时才算成功；
   * 其余情况一律留在待核对，由运营决定是补录回执还是重新报名。
   */
  async confirm(registrationId, rawReceipt) {
    const current = this.#require(registrationId);
    if (current.status === RegistrationStatus.CONFIRMED) {
      throw new RegistrationError('ALREADY_CONFIRMED', '报名已确认', { registrationId });
    }
    const settled = current.status === RegistrationStatus.REJECTED ||
      current.status === RegistrationStatus.NOT_ACCEPTED;
    if (!settled && !current.requiresReview && current.status !== RegistrationStatus.SUBMITTING) {
      throw new RegistrationError('INVALID_STATE', '只有提交结果待定的报名可以核对回执', {
        registrationId,
        status: current.status,
      });
    }

    const receipt = normalizeReceipt(rawReceipt);
    if (!receipt.valid) {
      return this.#leaveForReview(current, ReviewReason.RECEIPT_INCOMPLETE, receipt.reason, {
        receipt: rawReceipt ?? null,
      });
    }
    if (receipt.registrationKey !== current.registrationKey) {
      return this.#leaveForReview(
        current,
        ReviewReason.RECEIPT_MISMATCH,
        '回执对应的报名与当前报名不一致',
        { receipt: receipt.payload },
      );
    }
    if (receipt.kind === 'unknown') {
      return this.#leaveForReview(
        current,
        ReviewReason.UNRECOGNIZED_RECEIPT,
        `无法识别的回执状态：${receipt.status}`,
        { receipt: receipt.payload },
      );
    }

    const existing = this.#byReceipt.get(receipt.receiptId);
    if (existing && existing.registrationId !== current.id) {
      return this.#leaveForReview(
        current,
        ReviewReason.RECEIPT_CONFLICT,
        '该回执已关联到另一份报名',
        { receipt: receipt.payload, receiptOwner: existing.registrationId },
      );
    }

    // 已有结论（明确拒绝或核对为未报名）时又收到确认回执：两个结论冲突，
    // 可能已经占到名额，交给运营重新核对，而不是悄悄推翻原结论或宣告成功。
    if (settled && receipt.kind === 'confirmed') {
      return this.#leaveForReview(
        current,
        ReviewReason.RECEIPT_CONFLICT,
        '收到与既有结论冲突的确认回执，需重新核对名额',
        { receipt: receipt.payload },
      );
    }

    const now = new Date().toISOString();
    const confirmed = receipt.kind === 'confirmed';
    return structuredClone(
      await this.#commit({
        ...current,
        status: confirmed ? RegistrationStatus.CONFIRMED : RegistrationStatus.REJECTED,
        requiresReview: false,
        reviewReason: null,
        reviewDetail: null,
        confirmedAt: confirmed ? (receipt.confirmedAt ?? now) : null,
        resolvedAt: now,
        resolution: confirmed ? { by: 'portal_receipt', receiptId: receipt.receiptId } : null,
        lastError: confirmed ? null : `门户回执状态：${receipt.status}`,
        lastErrorDetail: null,
        updatedAt: now,
        receipts: [
          ...current.receipts.filter((entry) => entry.receiptId !== receipt.receiptId),
          receipt,
        ],
      }),
    );
  }

  /** 门户明确拒绝：已确定没有占位，可以核对原因后重新提交。 */
  async recordRejection(registrationId, { reason, details } = {}) {
    const current = this.#require(registrationId);
    if (current.status === RegistrationStatus.CONFIRMED) {
      throw new RegistrationError('ALREADY_CONFIRMED', '报名已确认', { registrationId });
    }
    const now = new Date().toISOString();
    return structuredClone(
      await this.#commit({
        ...current,
        status: RegistrationStatus.REJECTED,
        requiresReview: false,
        reviewReason: null,
        reviewDetail: null,
        confirmedAt: null,
        lastError: reason ?? '门户明确拒绝报名',
        lastErrorDetail: details ?? null,
        updatedAt: now,
      }),
    );
  }

  /**
   * 把结果未知的报名交给运营核对，可附带已拿到的可疑回执，
   * 但绝不据此判定成功。
   */
  async markUncertain(registrationId, { reason, detail, receipt } = {}) {
    const current = this.#require(registrationId);
    if (current.status === RegistrationStatus.CONFIRMED) {
      return structuredClone(current);
    }
    if (!reason) {
      throw new RegistrationError('REVIEW_REASON_REQUIRED', '待核对报名必须说明原因');
    }
    if (current.requiresReview) {
      // 已待核对时只补充信息，不改变原有的待核对结论。
      return structuredClone(
        await this.#commit({
          ...current,
          reviewDetail: detail ?? current.reviewDetail,
          lastError: detail ?? current.lastError,
          receipts:
            receipt === undefined || receipt === null
              ? current.receipts
              : [
                  ...current.receipts,
                  { valid: false, reason: String(detail ?? '待核对'), payload: receipt },
                ],
          updatedAt: new Date().toISOString(),
        }),
      );
    }
    return this.#leaveForReview(current, reason, detail ?? null, { receipt });
  }

  /**
   * 运营核对后的收口：
   * - confirmed：判定已报名，必须附上能对上这份报名的回执；
   * - not_accepted：判定未占名额，报名回到可重新提交状态。
   * 两者都必须留下核对人与依据。
   */
  async resolveReview(registrationId, { outcome, checkedBy, note, receipt } = {}) {
    const current = this.#require(registrationId);
    if (!current.requiresReview) {
      throw new RegistrationError('NOT_AWAITING_REVIEW', '该报名不在待核对队列中', {
        registrationId,
        status: current.status,
      });
    }
    const operator = String(checkedBy ?? '').trim();
    if (!operator) {
      throw new RegistrationError('OPERATOR_REQUIRED', '核对记录必须包含核对人');
    }
    const remark = String(note ?? '').trim();
    if (!remark) {
      throw new RegistrationError('REVIEW_NOTE_REQUIRED', '核对记录必须写明依据');
    }

    const now = new Date().toISOString();
    const base = {
      ...current,
      requiresReview: false,
      reviewReason: null,
      reviewDetail: null,
      resolvedAt: now,
      resolution: { by: operator, note: remark, at: now, outcome },
      updatedAt: now,
    };

    if (outcome === 'confirmed') {
      const normalized = normalizeReceipt(receipt);
      if (!normalized.valid) {
        throw new RegistrationError('RECEIPT_REQUIRED', '判定已报名需要可关联的回执', {
          reason: normalized.reason,
        });
      }
      if (normalized.registrationKey !== current.registrationKey) {
        throw new RegistrationError('RECEIPT_MISMATCH', '回执对应的报名与当前报名不一致');
      }
      if (normalized.kind !== 'confirmed') {
        throw new RegistrationError('RECEIPT_NOT_CONFIRMING', '回执并未确认报名成功');
      }
      const existing = this.#byReceipt.get(normalized.receiptId);
      if (existing && existing.registrationId !== current.id) {
        throw new RegistrationError('RECEIPT_CONFLICT', '该回执已关联到另一份报名');
      }
      return structuredClone(
        await this.#commit({
          ...base,
          status: RegistrationStatus.CONFIRMED,
          confirmedAt: normalized.confirmedAt ?? now,
          lastError: null,
          receipts: [
            ...current.receipts.filter((entry) => entry.receiptId !== normalized.receiptId),
            normalized,
          ],
        }),
      );
    }

    if (outcome === 'not_accepted') {
      return structuredClone(
        await this.#commit({
          ...base,
          status: RegistrationStatus.NOT_ACCEPTED,
          confirmedAt: null,
        }),
      );
    }

    throw new RegistrationError('INVALID_OUTCOME', '核对结论必须是 confirmed 或 not_accepted', {
      outcome,
    });
  }

  #path() {
    return resolve(this.#dir, 'registrations.json');
  }

  #require(registrationId) {
    const found = this.#registrations.get(registrationId);
    if (!found) {
      throw new RegistrationError('REGISTRATION_NOT_FOUND', '找不到这份报名', {
        registrationId,
      });
    }
    return found;
  }

  async #leaveForReview(current, reason, detail, { receipt } = {}) {
    const now = new Date().toISOString();
    const receipts =
      receipt === undefined || receipt === null
        ? current.receipts
        : [
            ...current.receipts,
            { valid: false, reason: String(detail ?? '待核对'), payload: receipt },
          ];
    // 之前若有结论（例如已核对为未报名），保留它作为本次核对的历史依据。
    const priorConclusions = current.resolution ? [current.resolution] : [];
    return this.#commit({
      ...current,
      status: RegistrationStatus.UNCERTAIN,
      requiresReview: true,
      reviewReason: reason,
      reviewDetail: detail ?? null,
      lastError: detail ?? null,
      receipts,
      resolutionHistory: [...(current.resolutionHistory ?? []), ...priorConclusions],
      updatedAt: now,
    });
  }

  #unindex(registration) {
    this.#registrations.delete(registration.id);
    if (this.#byKey.get(registration.registrationKey)?.id === registration.id) {
      this.#byKey.delete(registration.registrationKey);
    }
    for (const [receiptId, owner] of this.#byReceipt) {
      if (owner.registrationId === registration.id) this.#byReceipt.delete(receiptId);
    }
  }

  /** 回滚一次失败的落盘，但只在没有更新的进度覆盖它时生效。 */
  #rollback(previous, next) {
    if (this.#registrations.get(next.id)?.version !== next.version) return;
    this.#unindex(next);
    if (previous) this.#index(previous);
  }

  #index(registration) {
    this.#registrations.set(registration.id, registration);
    this.#byKey.set(registration.registrationKey, registration);
    for (const receipt of registration.receipts ?? []) {
      if (receipt?.valid && receipt.receiptId && receipt.kind === 'confirmed') {
        this.#byReceipt.set(receipt.receiptId, {
          registrationId: registration.id,
          receiptId: receipt.receiptId,
        });
      }
    }
  }

  /**
   * 单份报名的写入是原子的（tmp + rename）；并发调用按顺序串行落盘。
   * version 校验拒绝基于过期快照的写入，避免后到的结果覆盖较新的进度。
   * 落盘失败会回滚内存状态并抛给调用方，不会出现“内存已确认、磁盘没有”。
   */
  async #commit(registration) {
    const previous = this.#registrations.get(registration.id);
    if (previous && previous.version !== registration.version) {
      throw new RegistrationError('STALE_WRITE', '报名进度已被更新，拒绝过期写入', {
        registrationId: registration.id,
        expectedVersion: registration.version,
        currentVersion: previous.version,
      });
    }
    const next = { ...registration, version: (previous?.version ?? 0) + 1 };
    this.#index(next);
    if (!this.#dir) return next;

    const write = this.#writeChain.then(async () => {
      try {
        await this.#persist();
      } catch (error) {
        this.#rollback(previous, next);
        throw error;
      }
    });
    // 队列本身不携带失败：一次写入失败不应让之后的所有写入都短路。
    this.#writeChain = write.catch(() => {});
    await write;
    return next;
  }

  async #persist() {
    const snapshot = {
      version: 1,
      savedAt: new Date().toISOString(),
      registrations: [...this.#registrations.values()],
    };
    await mkdir(dirname(this.#path()), { recursive: true });
    const tmp = `${this.#path()}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    await rename(tmp, this.#path());
  }
}
