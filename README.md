# sport_track_api — 运动轨迹后端服务

> 版本：v0.1（目录已就位，代码待实现计划确认后编写）
> 项目文档：`../sport_track_miniapp/docs/`

## 技术栈
- Node.js + **Fastify** + **Mongoose**
- 数据库：MongoDB（本地/线上已有实例，新建独立库）
- 文件存储：阿里云 OSS（STS 临时凭证直传）
- 鉴权：JWT（`@fastify/jwt`，微信静默登录）
- 部署：云服务器 + Docker

## 规划目录结构
```
sport_track_api/
├── src/
│   ├── app.js               # Fastify 实例、插件注册、路由挂载
│   ├── server.js            # 启动入口
│   ├── config/              # 环境变量、常量（运动类型/MET 系数等）
│   ├── plugins/             # mongodb / jwt / error-handler 插件
│   ├── models/              # user / activity 模型
│   ├── services/            # wechat / oss / activity / stats / gpx
│   ├── routes/              # auth / user / activity / stats / oss / share
│   └── utils/
├── test/                    # 接口测试
├── Dockerfile
├── docker-compose.yml
└── package.json
```

## 详细设计
见 `../sport_track_miniapp/docs/04-后端架构.md`
