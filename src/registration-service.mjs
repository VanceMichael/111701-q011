import {
  PortalRejectionError,
  PortalTimeoutError,
  PortalTransportError,
  RegistrationError,
  RegistrationStatus,
  ReviewReason,
  canSubmitRegistration,
  normalizeDraft,
} from './registration-model.mjs';

export const DEFAULT_RECEIPT_TIMEOUT_MS = 15_000;

export {
  PortalRejectionError,
  PortalTimeoutError,
  PortalTransportError,
  RegistrationError,
  RegistrationStatus,
  ReviewReason,
};

/**
 * 单份报名的提交编排。
 *
 * portal.submit(registration) 负责与门户交互，必须：
 * - 成功时返回回执对象；
 * - 门户明确拒绝时抛出 PortalRejectionError；
 * - 结果未知（超时/连接中断）时抛出 PortalTimeoutError 或 PortalTransportError。
 *
 * 本编排在调用门户之前先落盘 submitting，因此无论进程如何中断，
 * 重启后同一份报名都只会是“待核对”，不会被自动重提。
 */
export class RegistrationService {
  #store;
  #portal;
  #receiptTimeoutMs;

  constructor({ store, portal, receiptTimeoutMs = DEFAULT_RECEIPT_TIMEOUT_MS } = {}) {
    if (!store) throw new RegistrationError('STORE_REQUIRED', '缺少报名进度存储');
    if (!portal || typeof portal.submit !== 'function') {
      throw new RegistrationError('PORTAL_REQUIRED', '缺少门户适配器');
    }
    if (!Number.isFinite(receiptTimeoutMs) || receiptTimeoutMs <= 0) {
      throw new RegistrationError('INVALID_TIMEOUT', '回执超时必须是正数毫秒');
    }
    this.#store = store;
    this.#portal = portal;
    this.#receiptTimeoutMs = receiptTimeoutMs;
  }

  /**
   * 进入一份报名：有进度就接着用，没有才新建。
   * 草稿按步骤并入已有进度，不会因为重进流程而多占一个名额。
   */
  async open({ student, offeringId, draft }) {
    const registration = await this.#store.ensureRegistration({ student, offeringId });
    if (draft === undefined) return registration;
    // 已有结论（已确认/待核对）或正在提交的报名不允许被新草稿覆盖；
    // 此时原样返回，由调用方查看进度。
    if (
      registration.status === RegistrationStatus.CONFIRMED ||
      registration.status === RegistrationStatus.SUBMITTING ||
      registration.requiresReview
    ) {
      return registration;
    }
    return this.#store.saveDraft(registration.id, normalizeDraft(draft));
  }

  async saveDraft(registrationId, draftPatch) {
    return this.#store.saveDraft(registrationId, draftPatch);
  }

  /** 只读取当前状态，不做任何提交。 */
  status(registrationId) {
    return this.#store.get(registrationId);
  }

  /**
   * 提交一份报名。落点只有三种：
   * - confirmed：拿到可核对回执；
   * - rejected：门户明确拒绝（未占名额，可核对原因后重新提交）；
   * - uncertain：结果未知，已进入运营核对队列，绝不在此自动重试。
   *
   * 重复调用同一个 registrationId 是安全的：已确认原样返回，
   * 待核对/提交中原样返回，均不会再次访问门户。
   */
  async submit(registrationId, { draft } = {}) {
    let registration = this.#store.get(registrationId);
    if (!registration) {
      throw new RegistrationError('REGISTRATION_NOT_FOUND', '找不到这份报名', {
        registrationId,
      });
    }

    if (registration.status === RegistrationStatus.CONFIRMED) {
      return { registration, submitted: false, outcome: 'confirmed' };
    }
    if (registration.status === RegistrationStatus.SUBMITTING) {
      // 同进程内另一个调用正在等回执：只报告“进行中”，不重复提交，
      // 也不擅自把结果标成待核对。进程真正退出由 store.load() 的恢复逻辑处理。
      return { registration, submitted: false, outcome: 'in_flight' };
    }
    if (registration.requiresReview) {
      return { registration, submitted: false, outcome: 'needs_review' };
    }
    if (!canSubmitRegistration(registration)) {
      throw new RegistrationError('INVALID_STATE', '当前进度不允许提交', {
        registrationId,
        status: registration.status,
      });
    }

    if (draft !== undefined) {
      await this.#store.saveDraft(registrationId, normalizeDraft(draft));
    }

    let attempt;
    try {
      attempt = await this.#store.beginSubmission(registrationId);
    } catch (error) {
      // 并发调用者可能刚刚推进了状态；以盘上的进度为准，不接触门户。
      if (error?.code === 'SUBMISSION_IN_FLIGHT' || error?.code === 'REVIEW_PENDING') {
        const current = this.#store.get(registrationId);
        return {
          registration: current,
          submitted: false,
          outcome:
            current?.status === RegistrationStatus.SUBMITTING ? 'in_flight' : 'needs_review',
        };
      }
      throw error;
    }

    const controller = new AbortController();
    try {
      const receipt = await this.#submitWithDeadline(attempt, controller);
      const settled = await this.#store.confirm(registrationId, receipt);
      if (settled.requiresReview) {
        return { registration: settled, submitted: true, outcome: 'needs_review' };
      }
      return {
        registration: settled,
        submitted: true,
        outcome:
          settled.status === RegistrationStatus.CONFIRMED ? 'confirmed' : 'rejected',
      };
    } catch (error) {
      controller.abort();
      return this.#settleFailure(registrationId, error);
    }
  }

  async #submitWithDeadline(attempt, controller) {
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new PortalTimeoutError(`等待门户回执超过 ${this.#receiptTimeoutMs}ms`));
      }, this.#receiptTimeoutMs);
      controller.signal.addEventListener(
        'abort',
        () => reject(new PortalTransportError('提交已中止')),
        { once: true },
      );
    });
    try {
      const outcome = await Promise.race([
        Promise.resolve().then(() =>
          this.#portal.submit(structuredClone(attempt), { signal: controller.signal }),
        ),
        deadline,
      ]);
      if (outcome === undefined || outcome === null) {
        throw new PortalTransportError('门户未返回回执');
      }
      return outcome;
    } finally {
      clearTimeout(timer);
    }
  }

  async #settleFailure(registrationId, error) {
    if (error instanceof PortalRejectionError) {
      // 明确拒绝 = 已确定没有占上名额，可以安全重试。
      const current = this.#store.get(registrationId);
      if (current?.status === RegistrationStatus.CONFIRMED) {
        // 回执先到、拒绝后到：已确认的报名不因迟到的拒绝被推翻。
        return { registration: current, submitted: true, outcome: 'confirmed' };
      }
      const registration = await this.#store.recordRejection(registrationId, {
        reason: error.message,
        details: error.details,
      });
      return { registration, submitted: true, outcome: 'rejected' };
    }

    if (error instanceof PortalTimeoutError || error instanceof PortalTransportError) {
      // 结果未知：先交给运营核对。若门户恰好附上了能对上的回执，
      // 仍由 store 校验身份后才收口；对不上的只会继续留在待核对。
      if (error.details?.receipt !== undefined) {
        const settled = await this.#store.confirm(registrationId, error.details.receipt);
        return {
          registration: settled,
          submitted: true,
          outcome: settled.requiresReview ? 'needs_review' : 'confirmed',
        };
      }
      const registration = await this.#store.markUncertain(registrationId, {
        reason:
          error instanceof PortalTimeoutError
            ? ReviewReason.RECEIPT_TIMEOUT
            : ReviewReason.PROCESS_INTERRUPTED,
        detail: error.message,
      });
      return { registration, submitted: true, outcome: 'needs_review' };
    }

    // 适配器抛出的未预期错误同样不能当成“没报上”。
    const registration = await this.#store.markUncertain(registrationId, {
      reason: ReviewReason.PORTAL_ERROR,
      detail: error?.message ?? '门户返回未预期的错误',
    });
    return { registration, submitted: true, outcome: 'needs_review' };
  }

  /**
   * 迟到的回执或人工查到的回执。只有能对上这份报名且明确确认的才收口；
   * 其他情况仍留在待核对队列。
   */
  async recordReceipt(registrationId, receipt) {
    return this.#store.confirm(registrationId, receipt);
  }

  /** 只读的运营核对队列。 */
  reviewQueue() {
    return this.#store.pendingReview();
  }

  /**
   * 运营核对结论：
   * - confirmed：附上门户回执，报名收口为已确认；
   * - not_accepted：确认未占名额，报名回到可重新提交状态。
   * 两种情况都必须留下核对人和依据。
   */
  async resolve(registrationId, resolution) {
    return this.#store.resolveReview(registrationId, resolution);
  }
}
