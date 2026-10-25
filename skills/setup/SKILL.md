---
name: setup
description: Set up the local Zotero reader, check Zotero connectivity, and guide optional local layout and MinerU configuration.
---

Check the local Zotero connection with a read-only library search, then open `reader_open` so the user can see the reader. If Zotero is unavailable, ask the user to start Zotero and enable its local API in advanced settings; never access its database directly.

Explain that ordinary reading and local layout do not upload PDFs. Local layout is enabled by default and requires the optional Python/model setup described in the installed plugin's source `INSTALL.md`. If the runtime is missing, native PDF blocks remain available.

For optional MinerU OCR, point the user to plugin settings → 设置与 MinerU 密钥, or the reader settings drawer. The API key must be entered into the password field, never requested in chat or placed in model context. Saving a key enables model-driven OCR by default unless the user disabled it. The global switch controls every paper; opening a paper never triggers OCR automatically.

Do not start cloud OCR as a setup test. Show how to select a block, add it to context, remove it using its page marker, and choose direct sending or an editable draft. Full text is fetched by tools only when needed for the current question.
