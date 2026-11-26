# R2.2.5-rc.1 发布产物 SHA256 清单

## 一、插件发布包（4 个入口文件 · 与生产逐字节一致）

| 文件 | 字节 | sha256 |
|---|---|---|
| `server/index.js` | 1908179 | `279b79ca819c181516130e18c991f7cfd374f01cd9f8b3f809dbe34e393e08ad` |
| `client/index.js` | 769788 | `767e18be158d3fc17243de751ff6d199f691baa5adc5c8b58e6742b60f9ef47a` |
| `client-v2/index.js` | 243640 | `e9036ac067620a583b2f1009137a8a90fc539743e54a06355a3e817949bf98e5` |
| `build-fingerprint.json` | 27306 | `0b831b599437214849b3519b061637b6e6ed991852cef60837fc179d6794c038` |

源码指纹 digest = `f792e31761b45282f1b16b7410614b9fac274056eb14c9bd8801f349fd54a231`（235 文件）

## 二、移动端 /m/ 发布包（9 个文件 · 与生产逐字节一致）

| 文件 | 字节 | sha256 |
|---|---|---|
| `favicon.svg` | 237 | `47c394f03890560ebd20d66ff4587c3ef5b5c18253e5f8aef8672f2060765fb9` |
| `index.html` | 2820 | `6cdfec44cf9cf283a9eece518842567190f646d71671e53049d26bc5987a423f` |
| `manifest.webmanifest` | 465 | `4e03308b83c384580f6b08bfdc8aa02b036ee0611fc1248bb56f554ef3a0f3b2` |
| `qf-hvac-intro.svg` | 538 | `bda208fa45635ef4db7d5cda51a4cc7d4de12ce09a0653a385b871cff04956e2` |
| `qf-hvac-six-stages.svg` | 2218 | `56f82db8add1ca9b38530bd5ef0e8e698a24f522d47d89c2142ee7a77dbf7456` |
| `assets/index-B-w0TeKE.js` | 158574 | `c8745b306416ee8d037d2ed884b96cb70caf914a7bc07b39cae86a6bbdeaa969` |
| `assets/konsta-C2FtRk8f.js` | 87522 | `00c3cc7a7fc227d59b222b98cf75cf9b7fd90c750bd7c5bbd7f73d00049e2f91` |
| `assets/react-vendor-CRH2syub.js` | 141843 | `fa5d2eaa88b62a5b30381dd4de11fa66e5a6fd3c31bc1b95ca66871ade33ea70` |
| `assets/style-BRWHbFyJ.css` | 123727 | `613249a1f27fc6dd4b371efd5fe5f21aaa80f50c928326554025b69449614352` |

## 三、生产实际在线文件（部署后回读）

```
-- 旧资源仍保留在线上（供秒级回滚），index.html 已不再引用 --
assets/index-CBbEj7Iy.js    5671223bf873504f971933b665ebd8f95488989410be667338d0185e78dd5daf
assets/style-7l-5ly0Z.css   ca88684dcd4a92bebccc1c855115c8e4caf5414a14208ee8a7e121449c37051d
```
