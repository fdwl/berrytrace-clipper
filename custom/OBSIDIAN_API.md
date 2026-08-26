# Berrytrace URL Scheme 接口文档

基于 Obsidian Web Clipper 源码整理，原始文档: https://obsidian.md/help/web-clipper

## 接口列表

### 1. 打开日常笔记
```
berrytrace://daily?
```
打开当前日期的日常笔记。如果不存在则创建。

**参数**: 无

---

### 2. 创建/编辑笔记
```
berrytrace://new?file=<路径/文件名>
```

**必需参数**:
| 参数 | 说明 |
|------|------|
| file | 文件路径和名称，需要 URL 编码 |

**可选参数**:
| 参数 | 说明 | 值 |
|------|------|-----|
| append | 添加内容到文件末尾 | true |
| prepend | 添加内容到文件开头 | true |
| overwrite | 覆盖文件内容 | true |
| vault | 保管库名称 | 保管库名称（需精确匹配） |
| silent | 静默打开，不激活窗口 | true |
| clipboard | 从剪贴板读取内容 | (无值) |
| content | 直接传递内容（受 URL 长度限制） | URL 编码的文本 |

---

## 使用示例

### 创建新笔记
```
berrytrace://new?file=MyFolder/MyNote.md
```

### 添加到日常笔记
```
berrytrace://daily?&append=true
```

### 指定保管库
```
berrytrace://new?file=Notes/Example.md&vault=MyVault&append=true
```

### 使用剪贴板传输内容（推荐用于大内容）
```
berrytrace://new?file=Notes/Example.md&clipboard
```

### 静默打开
```
berrytrace://new?file=Notes/Example.md&silent=true
```

---

## 内容传输机制

由于 URL 参数有长度限制（通常 2KB-8KB），剪藏插件采用以下策略：

1. **优先使用剪贴板**: 将内容复制到剪贴板，通过 `&clipboard` 参数指示目标应用从剪贴板读取
2. **回退方案**: 如果剪贴板写入失败，则使用 `&content=<内容>` 参数直接传递

---

## 与 Obsidian 的兼容性

此接口设计兼容 Obsidian URL Scheme，只需将 `berrytrace://` 替换为 `obsidian://` 即可用于 Obsidian。
