# 隐私模式：榜单与资料卡对他人匿名（设计）

日期：2026-11-09　状态：已确认（Q1=A 隐藏自己 / Q2=自己可见自己 / Q3=直接隐藏+半屏toast / Q4=与 showSportData 并存）

## 需求

设置页新增「隐私模式」开关。开启后，**自己在运动榜/微信步数榜的上榜条目对他人匿名**：
昵称、头像不展示；运动数据（距离/步数/条数/时长/配速）隐藏；uid 不下发（他人不可点开资料卡）。
资料半屏接口对隐私用户**拒绝下发**（前端 toast「该用户已开启隐私模式」，不弹半屏）。
自己看自己：榜单 me 区/自己的条目保持真实。与已有 `showSportData` 开关并存（口径不同：showSportData 只管资料卡累计数据；privacyMode 是榜单级匿名 + 资料卡整体隐藏）。

## 其他用户可见的真实数据面盘点（轨迹详情已另行处理，除外）

1. 运动榜 `GET /stats/leaderboard`（rows/best/me）：昵称、头像、距离、轨迹数、时长、配速、uid、会员标记
2. 资料半屏 `GET /stats/profile/:uid`：uid、昵称、头像+大图、已加入天数、累计八项、足迹省市数、会员标记
3. 微信步数榜 `GET /werun/board`（top/me/players 聚合数）：昵称、头像、步数、uid、性别、会员标记
4. 活动 `/campaigns/*`：小程序入口已移除，无暴露面（服务端保留，不处理）

## 实现（全部服务端下发时过滤，真实值不下发）

### API

1. `user.settings.privacyMode`（Boolean，默认 false）：model + PUT /users/me 的 SettingsSchema。
2. `leaderboard.ts`：
   - users 查询 select 增加 `settings.privacyMode`；infoById 行带 `privacy` 布尔；
   - `toRow` 增加查看者参数：行用户开隐私 **且 行用户 ≠ 查看者** 时 →
     `name:'隐私用户'、gender:0、avatarUrl/avatarPreset:''、uid:0、distanceKm:0、count:0、durationSec:0、paceSecPerKm:null、memberActive:false、privacy:true`；
   - `best`（本榜最佳）同样匿名（value/durationSec 不下发真实值）；
   - `RankRow`/`BestRow` 增加 `privacy?: boolean`；查看者自己的行保持真实（Q2）。
3. `werun-board.ts`：同款 —— `name:'隐私用户'、gender:0、头像空、uid:0、step:0、memberActive:false、privacy:true`；`me` 是查看者本人 → 真实；`players` 聚合数保留。
4. `public-profile.ts`：目标用户开了隐私 → 只返回 `{ privacyMode: true }`（其余字段零值），不查 overview/footprint；`PublicProfile` 增加 `privacyMode: boolean`。
5. 限流、settleFrom、TOP50 等既有口径零改动。

### 小程序

6. 设置页：新增「隐私模式」开关卡（文案：开启后，你在运动榜与步数榜的昵称、头像与运动数据对他人隐藏），随整体 settings 走 PUT /users/me。
7. 运动榜页：`privacy` 行的「N km」渲染为「已隐藏」；行点击（uid=0）静默不弹资料卡。
8. 步数榜页：`privacy` 行的步数渲染为「已隐藏」。
9. 资料半屏调用方：响应带 `privacyMode: true` → toast「该用户已开启隐私模式」，不弹半屏。

## 测试

- API：榜单匿名化（他人视角 privacy 行匿名 / 本人视角真实 / 未开隐私零变化）、werun 同款、profile 拒绝形态、settings 持久化 privacyMode。
- 小程序：settings 开关持久化；leaderboard/werun privacy 行文案；profile privacyMode toast 分支。
