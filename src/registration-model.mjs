import { createHash } from 'node:crypto';

/**
 * 单份报名的状态。
 *
 * submitting 不落成“成功”：只有拿到可核对回执才是 confirmed。
 * uncertain 表示“门户可能已经收下，也可能没有”，只能由运营核对后收口。
 */
export const RegistrationStatus = Object.freeze({
  DRAFT: 'draft',
  SUBMITTING: 'submitting',
  CONFIRMED: 'confirmed',
  REJECTED: 'rejected',
  UNCERTAIN: 'uncertain',
  NOT_ACCEPTED: 'not_accepted',
});

/** 进入运营核对的原因，便于筛选和统计。 */
export const ReviewReason = Object.freeze({
  RECEIPT_TIMEOUT: 'receipt_timeout',
  PORTAL_ERROR: 'portal_error',
  PROCESS_INTERRUPTED: 'process_interrupted',
  RECEIPT_INCOMPLETE: 'receipt_incomplete',
  RECEIPT_MISMATCH: 'receipt_mismatch',
  RECEIPT_CONFLICT: 'receipt_conflict',
  UNRECOGNIZED_RECEIPT: 'unrecognized_receipt',
  MANUAL: 'manual',
});

const ACCEPTED_RECEIPT_STATUSES = new Set([
  'accepted',
  'approved',
  'confirmed',
  'registered',
  'success',
]);

const REJECTED_RECEIPT_STATUSES = new Set([
  'cancelled',
  'canceled',
  'declined',
  'failed',
  'rejected',
]);

const SUBMITTABLE_STATUSES = new Set([
  RegistrationStatus.DRAFT,
  RegistrationStatus.REJECTED,
  RegistrationStatus.NOT_ACCEPTED,
]);

export class RegistrationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RegistrationError';
    this.code = code;
    this.details = details;
  }
}

/** 门户明确拒绝（例如校验失败、名额已满且未占位），重试不会重复占名额。 */
export class PortalRejectionError extends Error {
  constructor(message = '门户明确拒绝报名', details = {}) {
    super(message);
    this.name = 'PortalRejectionError';
    this.code = 'PORTAL_REJECTED';
    this.definitive = true;
    this.details = details;
  }
}

/** 回执返回前超时：结果未知，绝不能自动重试。 */
export class PortalTimeoutError extends Error {
  constructor(message = '等待门户回执超时', details = {}) {
    super(message);
    this.name = 'PortalTimeoutError';
    this.code = 'PORTAL_TIMEOUT';
    this.definitive = false;
    this.details = details;
  }
}

/** 请求在途中断（连接重置等），同样属于结果未知。 */
export class PortalTransportError extends Error {
  constructor(message = '与门户的连接中断', details = {}) {
    super(message);
    this.name = 'PortalTransportError';
    this.code = 'PORTAL_TRANSPORT_ERROR';
    this.definitive = false;
    this.details = details;
  }
}

function pickValue(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    return value;
  }
  return undefined;
}

function idString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function cloneJson(value, code, message) {
  try {
    return structuredClone(value);
  } catch (error) {
    throw new RegistrationError(code, message, { cause: error.message });
  }
}

export function normalizeStudent(student) {
  if (!student || typeof student !== 'object' || Array.isArray(student)) {
    throw new RegistrationError('INVALID_STUDENT', '学员身份必须是对象');
  }
  const { id, studentId, name, ...profile } = student;
  const normalizedId = idString(pickValue(id, studentId));
  if (!normalizedId) {
    throw new RegistrationError('INVALID_STUDENT', '学员身份缺少 id/studentId');
  }
  const normalizedName = idString(name);
  return {
    ...cloneJson(profile, 'INVALID_STUDENT', '学员身份包含无法保存的字段'),
    id: normalizedId,
    name: normalizedName || null,
  };
}

export function normalizeOfferingId(offeringId) {
  let value = offeringId;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    value = pickValue(value.id, value.offeringId);
  }
  const normalized = idString(value);
  if (!normalized) {
    throw new RegistrationError('INVALID_OFFERING', '报名缺少课程/班期标识');
  }
  return normalized;
}

export function normalizeDraft(draft) {
  if (draft === undefined || draft === null) return {};
  if (typeof draft !== 'object' || Array.isArray(draft)) {
    throw new RegistrationError('INVALID_DRAFT', '报名草稿必须是对象');
  }
  // 分步表单常以 undefined 表示“这一步还没填”，合并时不应抹掉已保存的值。
  const entries = Object.entries(draft).filter(([, value]) => value !== undefined);
  return cloneJson(Object.fromEntries(entries), 'INVALID_DRAFT', '报名草稿包含无法保存的字段');
}

/**
 * 一份报名由“学员身份 + 课程/班期”唯一确定，而不是由某一次提交流程确定。
 * 这样超时后重新进入时仍会落到同一份报名上，不会生成第二个名额。
 */
export function registrationKey(studentId, offeringId) {
  return JSON.stringify([idString(studentId), normalizeOfferingId(offeringId)]);
}

export function registrationIdForKey(key) {
  return `reg_${createHash('sha256').update(key).digest('hex').slice(0, 20)}`;
}

export function canSubmitRegistration(registration) {
  return Boolean(
    registration &&
      !registration.requiresReview &&
      SUBMITTABLE_STATUSES.has(registration.status),
  );
}

/**
 * 回执至少要能回答“哪一份报名”和“门户确认了什么”。
 * 缺少可关联身份的回执不会被当成成功，只会被列为待核对。
 */
export function normalizeReceipt(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, reason: '回执必须是对象' };
  }

  const receiptId = idString(
    pickValue(raw.receiptId, raw.id, raw.confirmationId, raw.confirmationNumber, raw.reference),
  );
  if (!receiptId) {
    return { valid: false, reason: '回执缺少 receiptId' };
  }

  const studentId = idString(pickValue(raw.studentId, raw.student?.id));
  const offeringId = idString(pickValue(raw.offeringId, raw.courseId, raw.sessionId));
  const providedKey = typeof raw.registrationKey === 'string' ? raw.registrationKey : null;

  let key = null;
  if (studentId && offeringId) {
    key = registrationKey(studentId, offeringId);
  } else if (providedKey) {
    key = providedKey;
  }
  if (!key) {
    return { valid: false, reason: '回执缺少学员身份或报名标识' };
  }

  if (studentId && offeringId && providedKey && providedKey !== key) {
    return { valid: false, reason: '回执中的学员身份与报名标识不一致' };
  }

  const rawStatus = idString(pickValue(raw.status, raw.state));
  const status = (rawStatus || 'confirmed').toLowerCase();
  const kind = ACCEPTED_RECEIPT_STATUSES.has(status)
    ? 'confirmed'
    : REJECTED_RECEIPT_STATUSES.has(status)
      ? 'rejected'
      : 'unknown';

  return {
    valid: true,
    receiptId,
    studentId: studentId || null,
    offeringId: offeringId || null,
    registrationKey: key,
    status,
    kind,
    confirmedAt: pickValue(raw.confirmedAt, raw.issuedAt) ?? null,
    payload: cloneJson(raw, 'INVALID_RECEIPT', '回执包含无法保存的字段'),
  };
}
