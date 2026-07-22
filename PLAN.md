# Astro Theme Bridge

在当前目录以 TypeScript 最新标准创建 Node.js 项目，基于 pnpm 包管理器。

该项目是一个适用于 Astro 的主题桥接工具，支持全局命令 `astro-theme-bridge`，用于根据配置文件，将当前目录中的指定或全部内容与已有的 Astro 主题项目合并并执行各类操作。

已有的 Astro 主题项目来源可以是 GitHub、本地目录等，此处应当抽象并复用重复逻辑。每个来源都应当有一个标识符，例如 github，完整的来源写法应为 github:ruattd/xxx local:srcxxx 等，即使用第一个英文冒号来分割，前半部分是标识符，后半部分是来源内容，其中 GitHub 应当支持使用 @v1.0.0 这样的方式来指定 ref (branch 或 tag 或 commit)，如 github:ruattd/xxx@v1.0.0。

该工具应当在当前项目目录创建一个 .astro-theme-bridge 并将所有临时文件和项目 merged 目录都放在里面，其中 merged 目录即将主题项目原内容放在其中，并将上述待合并内容合并进去之后的结果目录。

该工具应支持以下指令：

- init: 进行一个简单的向导式询问并在项目根目录生成默认的 astro-theme-bridge.yaml 配置文件和一个包含常用内容的 .gitignore 文件
- build: 生成 merged 内容，每次执行前应当删除 merged 目录中所有除了 node_modules 以外的文件，应支持 --clean 参数以同时删除 node_modules
- update: 若来源需要缓存（例如 github 仓库），该指令删除缓存并重新拉取
- run <script-and-args>: 自动跑一遍默认的 build 并 cd 到 merged 目录中运行 package 脚本（该脚本应根据 merged 目录的 package.json 的配置，使用对应包管理器来运行）
- dev <script-and-args>: 在 run 的基础上，同时实时监听除了 merged 目录以外的项目文件更改，并将更改实时应用到 merged 目录的目标文件上，并等待用户的 Ctrl+C 并向运行的脚本发送 SIGINT（自己不做任何额外操作），仅当运行的脚本退出时（无论是否执行了手动的 Ctrl+C）自己也退出
- help: 输出帮助

由于每次 build 都会清空 merged 目录，因此若来源是 github 仓库，build 操作时应当将该仓库缓存到 .astro-theme-bridge/github-repo 目录中并复制到 merged 目录，而不是每次都重新 clone

文件结构合并逻辑：

- 本项目的文件应覆盖掉主题项目的文件，声明为 merge 的文件应合并内容（具体规则在后面）
- 默认情况下包含所有非句点 (.) 开头的文件，忽略所有句点开头的文件（即 POSIX 规范定义的隐藏文件）
- 每个目录的 .astro-theme-bridge.yaml 文件可用于定义该目录及其子目录的规则，这个规则应继承和覆盖来自父目录的规则，任何作用于目录的规则，内部的文件路径均相对于该规则文件所在的目录
- 规则共有三种：include exclude merge，这三个规则均支持 gitignore 风格的通配符，均接受一个字符串或一个字符串数组，先根据 include，然后从 include 中 exclude，在剩下的文件中决定应当对什么执行 merge；若 include 未声明或为空，则默认根据上述不含隐藏文件的规则，若 exclude 未声明或为空，则默认不排除任何文件，若 merge 未声明或为空，则默认包含所有 json 和 yaml
- 特殊规则：.astro-theme-bridge.yaml 文件、astro-theme-bridge.yaml 文件、.astro-theme-bridge 目录、.git 目录、node_modules 目录在任何情况下均不应被包含

文件内容合并（仅支持 json/yaml，若有其他应报错）：

- 对于一般内容：直接覆盖
- 对于数组：若源键前面有一个 +，则在前方插入（去掉 + 符号），同理在后面有 + 则在后方插入，否则覆盖
- 对于对象：若源键前面有一个 ^ 则直接覆盖（去掉 ^ 符号），否则递归合并内部元素
