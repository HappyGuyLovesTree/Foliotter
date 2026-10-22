# Foliotter · 书獭

**抱着一本书，漂一会儿。**

A small local EPUB reader. Bring your own book; keep your reading on your computer.

书獭是一个本机电子书阅读器：导入自己的 EPUB，按章节翻页，搜索书文，收藏段落，记录想法，也可以随机遇见一段文字。程序使用 Python 标准库和原生 HTML/CSS/JavaScript；普通阅读不需要账号、云服务或 Node.js。

**这里只提供 MIT 许可的程序和原创图标，不附带书籍、译文、书注或原画。** 请自行提供合法取得且允许相应用途的电子书。软件许可证不授予书籍内容的传播权，详见 [NOTICE](NOTICE.md)。

## 开始阅读

安装 Python 3.10 或更高版本，下载并解压代码包，进入项目文件夹后运行：

```sh
python3 -B scripts/serve.py --open
```

浏览器会打开本机 `http://127.0.0.1:8787/`。首次启动进入书库，选择你自己的 EPUB，再点击 **导入并开始阅读**。导入完成后自动打开书页。已有书可从书库再次打开；阅读页有返回书库的入口。

macOS 也可双击 `启动阅读.command`。需要桌面入口和登录后后台运行时，双击 `安装桌面入口.command`；首次安装创建 `Foliotter.app`。应用和数据继续保存在你解压的位置，请不要在安装后随意移动。旧版用户沿用既有桌面入口和本机地址。

如果 8787 已被占用，可用 `python3 -B scripts/serve.py --port 8788 --open`。浏览器记录按地址保存，更换端口前请先导出记录。服务只监听本机，不要把它开放到公网。

## 支持什么

| 项目 | 当前范围 |
|---|---|
| 输入 | 无 DRM、可重排的 EPUB；单个文件最多 60 MiB |
| 阅读顺序 | 按 EPUB spine 顺序，章节名读取目录或正文标题 |
| 内容 | 文字、标题及支持的 JPEG、PNG、GIF、WebP 图片 |
| 阅读工具 | 章节目录、分页、字号、搜索、随机段落、收藏和笔记 |
| 多本书 | 独立保存；重复导入相同文件回到已有书籍 |
| 隐私 | 文件交给本机服务解析，不上传到远端；不保存源 EPUB 副本 |

导入会重新排版，不保证与出版社原版逐页一致。不支持 PDF、MOBI、AZW、DRM、字体混淆、固定版式和纯扫描图片书。SVG、音视频、脚本、嵌入字体、复杂公式与交互不予还原；链接和脚注跳转不保留。章节按正文文件划分，书内目录的更细子标题可能不单独成章。复杂或损坏的 ZIP/XML 会被拒绝，错误信息会保留在导入页面。

一本导入书按其原文阅读；本版本**不会自动翻译，也不会把两本不同语言的 EPUB 按段号硬配对**。旧版本地已校对的双语资料可以继续使用，但这些私人内容、校对映射和原画不随开源版提供。

## 书和记录存在哪里

- 转换后的书文和图片：项目下的 `user-library/`，每本书一个独立目录。该目录被 Git 和默认代码打包器排除。
- 阅读位置、收藏、笔记：当前浏览器的本机存储，每本导入书分别保存。换浏览器或清理站点数据前，在阅读页的“备份与恢复”导出记录。
- 备份书库：自行备份 `user-library/`；备份记录：使用阅读器导出。这两项都不会进入程序 ZIP。
- 当前没有图形化删除书籍功能。删除书籍前请先备份；关闭程序后，可自行移除对应的 `user-library/epub-…` 目录。

旧版本地资料保留在原位置，导入新书不会改写它们。`scripts/install_local_content.py` 只用于本人持有的旧个人离线包恢复，不是下载服务，不是新用户导入电子书的入口。

## 开发与发布检查

```sh
python3 -B -m unittest discover -s scripts -p 'test_*.py'
node --test scripts/test_reading_pages.cjs scripts/test_reader_import.cjs
python3 -B scripts/audit_release.py
python3 -B scripts/package_reader.py --output dist/Foliotter-code.zip
python3 -B scripts/audit_release.py --zip dist/Foliotter-code.zip
```

单元测试使用短篇原创合成材料，不需要私人书籍。发布器采用明确文件清单，新增程序文件需要同步清单。审查器检查候选文件、Git 索引与可达历史、常见密钥模式和包内指纹；它不能替代人工版权判断。旧私人开发仓库如果仍有私人文档历史，不能仅改公开，应从通过检查的程序包建立干净历史。

`--personal` 是兼容旧本地项目的私人打包选项，包含私人阅读数据，**不得上传到仓库或 Release**。它不包含新书库，也不是通用备份。公开发行只使用默认代码包。

图标源文件为 `packaging/redbook.svg`，已有可直接使用的 PNG/ICNS。可选重建脚本依赖 Node.js、sharp 和 macOS iconutil；阅读本身不需要它们。内部部分 `redbook` 名称为旧记录兼容保留。

## License

[MIT](LICENSE) for the software, documentation and original icon. Imported books and personal records are excluded. See [third-party notices](THIRD_PARTY_NOTICES.md), [security notes](SECURITY.md) and [contribution guide](CONTRIBUTING.md).
