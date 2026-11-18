# 职业培训报名采集服务

这是一个用于职业培训报名的本地数据采集与归档服务。当前版本从仓库自带的合成来源记录读取一页数据，经过字段规整后写入进程内目录；来源内容和规整后的记录保留独立边界，便于在不访问外部系统的情况下复现采集过程。

仓库同时包含一层“单份报名进度”模型，用于处理门户已收表、回执却超时的情况：一份报名由**学员身份 + 课程/班期**唯一确定，提交前先落盘，回执能对上身份才确认，结果不确定的报名进入运营核对队列，而不是被判成功或被自动重提。

## 运行

需要 Node.js 20 或更高版本，不需要安装第三方依赖。

```sh
npm test
npm run build
node src/pipeline.mjs
```

测试使用项目内的合成记录；执行不需要网络、凭据或外部服务。

## 单份报名进度

```js
import { RegistrationStore } from './src/registration-store.mjs';
import { RegistrationService } from './src/registration-service.mjs';

const store = await RegistrationStore.open({ dir: './state' });
const service = new RegistrationService({
  store,
  portal,                 // { async submit(registration) { ... } }
  receiptTimeoutMs: 15000,
});

const registration = await service.open({
  student: { id: 'S-1001', name: '张三' },
  offeringId: 'course-2026-A',
  draft: { step1: { name: '张三' } },   // 分步表单已填内容，重进时接着填
});

const result = await service.submit(registration.id);
// result.outcome:
//   confirmed    拿到可核对回执，已确认
//   rejected     门户明确拒绝，未占名额，可安全重提
//   needs_review 结果未知，已进入运营核对队列
//   in_flight    同一份报名正在提交，本次没有再次访问门户
```

### 约定

- **身份关联**：报名键是 `学员 id + 班期`，重复进入返回同一份进度；回执必须带上可对上的学员/班期（或报名键），否则不会确认。
- **进度落盘**：每次状态变化先写临时文件再 `rename`；提交前先把状态置为 `submitting`，进程中途退出后重启会转为 `uncertain`，不会再次提交。
- **不伪装成功**：只有 `confirmed` 携带有效回执；超时、连接中断、未识别回执、回执与报名对不上、回执已属于别的报名，全部留在 `uncertain`。
- **人工收口**：`service.reviewQueue()` 列出待核对报名；`service.resolve(id, { outcome, checkedBy, note, receipt })` 必须以核对人和依据收口。`outcome: 'confirmed'` 需要回执；`outcome: 'not_accepted'` 才会让报名回到可重新提交状态。
- `portal.submit` 的错误约定：明确拒绝抛 `PortalRejectionError`；超时抛 `PortalTimeoutError`；连接中断抛 `PortalTransportError`；其他异常同样按“结果未知”处理。

