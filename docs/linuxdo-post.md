# ManyMail：一个轻量的自建邮箱小工具

之前一直用临时邮箱收验证码，但总觉得不太放心：服务可能随时挂，邮件也不一定能留住。

我平时又经常要给不同域名、不同前缀收邮件，所以干脆做了一个简单的自建方案：**ManyMail**。

项目地址：

**https://github.com/margbug01/ManyMail**

![screenshot](https://raw.githubusercontent.com/margbug01/ManyMail/master/docs/screenshot.jpg)

## 它是干什么的？

简单说，就是一个可以跑在自己服务器上的轻量邮箱系统。

它主要解决这几件事：

- 收邮件：自带 SMTP 服务，别人发到你域名的邮件会存进 MongoDB
- 看邮件：有一个 Web 页面，可以查收件箱、搜索、删除、看详情
- 发邮件：可选接入 Resend，用 Web 页面直接发信/回复
- 多域名：可以挂多个域名，邮箱前缀随用随建
- IMAP：可以用 Thunderbird、手机邮件 App 这类客户端连接
- 外部邮箱聚合：也能把 Gmail、Outlook、QQ 邮箱等接进来统一看

我自己的使用场景主要是：收验证码、临时邮箱、多域名收信、偶尔回邮件。

## 部署方式

前提是一台能开放 25 端口的服务器。

```bash
git clone https://github.com/margbug01/ManyMail.git
cd ManyMail
cp .env.example .env
# 修改 .env 里的域名、密码、密钥
docker compose up -d
```

DNS 大概配这几条：

| 类型 | 名称 | 值 |
|:--|:--|:--|
| A | mail | 服务器 IP |
| MX | @ | mail.你的域名.com |
| TXT | @ | `v=spf1 ip4:你的IP ~all` |

然后打开 Web 页面就能用了。建议前面再套一层 Caddy / Nginx 做 HTTPS。

## 技术栈

没用 Postfix / Dovecot，整体比较轻：

- Python：FastAPI + Flask
- Node.js：IMAP 相关功能
- MongoDB：存邮件和账户
- Docker Compose：一键启动

甲骨文 ARM 小鸡这类机器也能跑，适合个人自用。

## 目前还有哪些不足

这个项目定位不是企业级邮局，更像是一个自用工具，所以还有一些地方比较简单：

- UI 还比较朴素
- 发信依赖第三方 Resend
- 反垃圾能力够基础使用，但不是专业邮件网关级别
- 大规模、多用户场景没有专门优化

## 最后

项目开源，MIT 协议，欢迎自用、改造、提 issue。

如果你也需要一个简单的自建收信工具，可以试试看：

**https://github.com/margbug01/ManyMail**

觉得有用的话，顺手点个 Star 就更好了。
