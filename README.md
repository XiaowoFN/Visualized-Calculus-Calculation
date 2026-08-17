# 微积分计算工具

一个运行在浏览器中的一重定积分计算工具。用户可以手写或直接输入被积函数与积分上下限，程序会识别表达式、执行数值积分，并绘制函数曲线与积分区域。

## 功能特性

- 支持鼠标、触控笔和触摸屏手写输入
- 支持画笔、橡皮、撤销和清屏操作
- 停笔后自动识别，也可以手动触发识别
- 积分上下限支持手写或文本输入
- 内置本地手写识别，无需配置即可使用
- 可选接入 MyScript 云识别，失败时自动回退到本地识别
- 使用自适应 Simpson 算法计算一重定积分
- 检测积分区间内可能存在的奇点并给出提示
- 使用 KaTeX 展示积分公式
- 绘制函数曲线和积分区域
- 在浏览器本地保存最近 20 条计算记录
- 响应式布局，支持桌面端和移动端

## 技术栈

- HTML5、CSS3、原生 JavaScript
- Canvas API：手写输入与函数绘图
- [math.js](https://mathjs.org/)：表达式解析与计算
- [KaTeX](https://katex.org/)：数学公式渲染
- [MyScript iinkTS](https://developer.myscript.com/)：可选的云端数学手写识别

项目不需要安装依赖或执行构建命令。math.js、KaTeX 和可选的 iinkTS 通过 CDN 加载。

## 快速开始

### 使用本地服务器

推荐通过本地 HTTP 服务器运行项目。在项目目录执行：

```powershell
python -m http.server 8000
```

然后在浏览器访问：

```text
http://localhost:8000
```

也可以使用 VS Code 的 Live Server 等静态文件服务器。

> 直接双击 `index.html` 可以使用大部分本地功能，但浏览器的安全策略可能影响云识别或外部资源加载。

## 使用方法

1. 在主画布中手写被积函数，等待自动识别，或点击“智能识别”。
2. 检查识别出的表达式，必要时直接在输入框中修改。
3. 手写或输入积分下限、积分上限，并设置积分变量。
4. 点击“计算定积分”查看数值结果、计算信息和函数图像。
5. 点击历史记录可以恢复之前的计算参数。

支持的常用函数包括：

```text
sin(x)  cos(x)  tan(x)  log(x)  ln(x)
sqrt(x) exp(x)  abs(x)
```

表达式示例：

```text
x^2
sin(x)
exp(-x^2)
sqrt(1-x^2)
2*x+1
```

乘法请使用 `*`，幂运算请使用 `^`。积分上下限可以输入普通数值，也可以输入 math.js 支持的常量或表达式，例如 `pi`、`pi/2`。

## 配置 MyScript 云识别

云识别是可选功能；未配置时应用会使用内置的本地识别器。

1. 注册 [MyScript 开发者账号](https://developer.myscript.com/getting-started/web/)。
2. 在 MyScript 控制台创建应用，获取 Application Key 和 HMAC Key。
3. 打开页面右上角的“云识别设置”。
4. 填入两个 Key，保存后点击“测试云连接”。

配置会保存在当前浏览器的 `localStorage` 中，不会写入项目文件。

> 安全提示：当前实现会在浏览器端使用并保存 HMAC Key，只适合本地学习和原型演示。公开部署时不要使用生产密钥，应通过受控后端代理云识别请求。

## 项目结构

```text
firstproject/
├── index.html                 # 页面结构与第三方资源入口
├── css/
│   └── style.css              # 页面样式与响应式布局
└── js/
    ├── app.js                 # 应用初始化、交互、结果、绘图与历史记录
    ├── canvas.js              # 手写画布与笔画管理
    ├── recognizer.js          # 本地数学表达式识别器
    ├── cloudRecognizer.js     # MyScript 云识别封装
    └── integrator.js          # 表达式解析与自适应 Simpson 积分
```

## 数据与网络说明

- 计算历史、MyScript 配置均保存在浏览器 `localStorage` 中。
- 本地识别在浏览器内完成，不上传笔画数据。
- 启用 MyScript 后，手写笔画会发送到配置的 MyScript 服务进行识别。
- 页面需要联网加载 CDN 上的 math.js 和 KaTeX；云识别还会加载 iinkTS 并访问 MyScript 服务。

## 已知限制

- 本地识别基于字体原型与图像特征，复杂公式的准确率有限。
- 当前只提供数值积分，不进行符号求原函数。
- 被积函数在区间内不连续、发散或高度振荡时，结果可能不可靠。
- 云识别的可用性和额度受 MyScript 账户及服务状态限制。
