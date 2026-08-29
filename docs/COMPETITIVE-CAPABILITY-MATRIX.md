# Competitive Capability Matrix

> **Purpose:** a market baseline for Nawi (PRD-001, PRD-002). This is
> competitor research: it records what an established product in this category
> does, so Nawi's own scope decisions are made against evidence rather than
> guesswork. Nawi is an independent product and not a reimplementation —
> where a row below says "no", that is a deliberate scope decision or an open
> backlog item, not a missing piece of a copy.
> **Subject:** Competitor A — an established commercial product in the screen
> capture and recording category. Version and vendor are deliberately omitted;
> the findings are what matter, not which build they came from.
> **Method:** black-box, read-only inventory of a licensed install. No licensing/DRM was
> analysed, no obfuscated binary decompiled, no proprietary asset extracted.
> **Extraction scope:** Tier 3 (whole application) per the proportionality table.
> **This document describes what Competitor A is, and what Nawi is. It does not prescribe
> what Nawi should become.** §4 lists evidenced gaps; the keep/drop decision is
> `product-manager`'s and `product-analyst`'s.

---

## 1. Method and evidence grading

### 1.1 Evidence tiers used

| Tier | Meaning |
|---|---|
| **O — Observed-from-install** | Directly read from a file, registry key, or PE metadata field on this machine. Citation is a path or key. |
| **V — Vendor-declared** | A shipped vendor artifact states it in words (PE `FileDescription`, help HTML copy, `3rdparty_licenses.txt`, JSON schema field names). Stronger than inference: the vendor is naming its own component. |
| **U — User-confirmed** | From the user's own screenshot of the Competitor A capture window, supplied as ground truth with this task. |
| **I — Inferred** | Reasoned from component names or bundled libraries. **A bundled DLL proves a library ships, not that a feature is user-reachable.** Treated as *candidate* throughout. |
| **∅ — Could not determine** | Listed explicitly in §1.4. |

Per `capability-extraction`: **Confirmed** = ≥2 independent sources agree.
**Candidate** = one source only. Nothing is promoted on inference alone.

### 1.2 What was NOT done — a stated limitation

**No web tool resolved in this environment.** `WebSearch`/`WebFetch` are not in this
agent's tool set. The task's instruction to cross-check ambiguous findings against
the vendor's public documentation **could not be carried out**. Therefore:

- There is **no `documented-publicly` evidence tier in this document.** Every finding is
  O, V, U, or I.
- Where public documentation would have settled an ambiguity (notably: which cloud share
  destinations are still live in the product UI vs. retired-but-still-linked), the finding
  is marked **candidate** and flagged in §1.4 rather than resolved.

The intended offline substitute, `en-US/Competitor AHelpOffline.pdf`, was extracted and read
(via zlib stream decompression). **It contains no feature documentation** — it is a
one-page "you appear to be offline, here are our online learning resources" leaflet
listing the vendor.com URLs. It is not usable as a vendor feature description.

### 1.3 Evidence sources actually used

| Source | What it established |
|---|---|
| Install-tree file listing (343 DLL/EXE + resource dirs) | Component inventory |
| PE `VersionInfo.FileDescription` on all 7 EXEs and ~35 first-party DLLs | Executable purposes (tier V) |
| `HKLM\SOFTWARE\Classes` targeted reads | COM automation surface, file associations |
| `Get-Printer` | Live "Competitor A" printer device |
| `EnhancedTooltips/*/ENU/index.html` | 22 editor tool names + vendor one-line descriptions (tier V) |
| `Favorites.json`, `Themes/*.snagtheme`, `Palettes/*.snagpalette` | QuickStyle/theme property schema |
| `.snagx` ZIP internals (`index.json`, `metadata.json`, page JSON) | Document/data model |
| `3rdparty_licenses.txt` §-headers | Vendor-declared third-party components |
| `Messages/Stitching.json`, `Surveys/JtbdSurvey.json` | Scrolling-capture UX, vendor's own JTBD framing |
| UTF-16 string scan of `a vendor artifact` | Command-line switches |
| Nawi `src/` reads | Column 3 of the matrix |

### 1.4 What could not be determined

1. **Public-documentation corroboration** — no web tool (§1.2). All "is this feature still
   in the UI?" questions are unresolved.
2. **Which share destinations are live vs. retired.** `Twitter.dll` + 8 `Tweetinvi.*`
   DLLs and `Evernote.dll` + `Thrift.dll` ship, but a shipped integration DLL is not proof
   of a reachable menu item. Marked **candidate, user-facing status unverified.**
3. **No dynamic observation was performed.** The Competitor A application was not launched — launching the capture host would have altered the user's live session. The user's profile data at
   `%LOCALAPPDATA%\the vendor\Competitor A` *was* read (read-only, nothing written — see §2.8a), which supplied
   the live preset schema without running anything. But no capture was taken, so every *behavioural*
   claim rests on static evidence plus the user's screenshot.
4. **COM interface *members*.** The registry gives ~50 ProgIDs but reading method
   signatures would require type-library inspection that was not performed. What each
   coclass *does* beyond its name is inference.
5. **OCR language coverage is partial.** `English/French/German/Spanish/PortugueseBrazilian`
   `.amd/.amt/.lm` files are present; whether more languages download on demand is unknown.
6. *(reduced)* **The Editor's UI was originally unknown.** A second user-supplied
   screenshot (§2.12) has since established its menu bar, mode tabs, tool rail, property
   panel, recent tray, and share controls. What remains unknown there: the contents of the
   `Assets` tab (ED-04), the contents of the `Create` mode (ED-05), the `View`/`Edit`/`Share`
   menu contents, and the Video-mode tool rail — the screenshot shows an image document.
7. **Video editing depth.** `VideoEditing.dll` is only 58.9 KB — the actual trim/cut/
   multi-track feature set is not derivable from the install tree, and the Editor
   screenshot shows an image document (§2.12), so the Video-mode surface is still unseen.
8. **Whether the freeze-frame model is used.** No evidence either way in static resources.

### 1.5 Dead / empty surface found (one line each, as findings not conclusions)

- `Competitor A.reg` — **0 bytes**.
- `DynamicHelpXML_ENU.xml` — **0 bytes**.
- `XP64/` contains `SP2K.INF`, `COMPETITOR-AP.GPD`, `a vendor artifact` — Windows-2000/XP-era printer
  driver naming, **but** `Get-Printer` shows a live installed printer named `Competitor A` with
  driver `Competitor A Printer Driver`. This is *not* dead residue; see CAP-09.
- `Competitor A.25.Picture` ProgID coexists with `Competitor A.26.Picture` — upgrade residue or
  deliberate back-compat; not determined.

---

## 2. Capability inventory

### 2.1 Executables (tier V — PE `FileDescription`)

| Binary | Vendor `FileDescription` | Role |
|---|---|---|
| `a vendor artifact` (9.4 MB) | `Competitor A` | Capture host — the window in the user's screenshot |
| `a vendor artifact` (11.1 MB) | `Competitor A Editor` | Editor / library / share |
| `Competitor API64.exe` | `Competitor A Printer Installer` | Installs the "Competitor A" printer |
| `SnagPriv.exe` | `Competitor A RPC Helper` | Elevated/cross-process helper |
| `crashpad_handler.exe`, `crashpad_http_upload.exe`, `crashpad_database_util.exe` | *(no description)* | Chromium Crashpad crash reporting (corroborated by `Crashreporting.dll`, `Backtrace.dll`) |
| `XP64/Competitor AD.dll` | `Competitor A Printer Driver` | The print driver itself |

**Notable absence:** there is **no separate updater EXE**. Update is in-process via
`TSCUpdater.dll` + `the vendor.OpenApi.UpdaterApi.dll` + `BITSReference5_0.dll` (BITS
background transfer). Status: **confirmed** (two components agree).

### 2.2 Capture — `CAP`

| ID | Capability | Status | Evidence |
|---|---|---|---|
| CAP-01 | All-in-One / Image / Video capture modes | Confirmed | U (mode rail) |
| CAP-02 | Region / window / full-screen selection | Confirmed | U (`Selection:` dropdown) + `a vendor module`, `a vendor module` (V: "selection module") |
| CAP-03 | **Scrolling capture** with stitching | Confirmed | U (`Selection: Scrolling`; preset `Ctrl+Shift+Space`) + `a vendor module` `FileDescription = "Scrolling capture support"` (V) + `Messages/Stitching.json` progress copy (O) |
| CAP-04 | Time delay capture | Confirmed | U (toggle) + `COMPETITOR-A.DelayOptions` COM class (O) |
| CAP-05 | Cursor include/exclude | Confirmed | U (toggle) + `COMPETITOR-A.RegionOptions` (O) |
| CAP-06 | Copy to clipboard on capture | Confirmed | U (toggle) + `COMPETITOR-A.ClipboardOptions` (O) |
| CAP-07 | Preview in Editor toggle | Confirmed | U |
| CAP-08 | Panoramic / auto-scroll capture | Candidate | `COMPETITOR-A.AutoScrollOptions` COM class (O) — distinct ProgID from scrolling selection |
| CAP-09 | **Print capture** — capture anything printable via a virtual printer | Confirmed | `Get-Printer` → name `Competitor A`, driver `Competitor A Printer Driver` (O) + `Competitor API64.exe` "Competitor A Printer Installer" (V) + `Competitor APt64.dll` "Competitor A Printer TIFF plugin" (V) + `COMPETITOR-A.PrinterOptions`/`PrinterPageLayoutOptions` (O) |
| CAP-10 | **TWAIN scanner / camera capture** | Candidate | `COMPETITOR-A.TWAINOptions` COM class (O), single source |
| CAP-11 | **Text capture (non-OCR, from window objects)** | Candidate | `COMPETITOR-A.TextCapture`, `COMPETITOR-A.ObjectTextOptions`, `COMPETITOR-A.TextFile`, `COMPETITOR-A.TextLayout`, `COMPETITOR-A.TextFilters` COM classes (O) |
| CAP-12 | Extended/client-area window capture (scrollbars, menus) | Candidate | `COMPETITOR-A.ExtendedWindowOptions`, `COMPETITOR-A.ClientWindowOptions`, `COMPETITOR-A.MenuOptions` (O) |
| CAP-13 | HDR-aware capture | Candidate | `HdrCapture.dll` (I) |
| CAP-14 | Modern Windows capture path | Candidate | `RecorderSDK.Win10ScreenCapture.dll` (I — name implies `Windows.Graphics.Capture`) |
| CAP-15 | UI-Automation-assisted capture/element awareness | **Candidate — important** | `Interop.UIAutomationClient.dll` (I). A UIA interop assembly ships. Whether it drives element-aware capture, accessibility, or only internal test automation **was not determined.** |
| CAP-16 | ML-assisted auto-crop of a capture | Candidate | `CropClassifierGeneric.imodel`, `CropLaunchCriteria.cnnmodel` (4.6 MB), `FastCrop.imodel` (I, but three coherent artifacts) |
| CAP-17 | Mobile device capture (the vendor Fuse / Mobile Connect) | Candidate | `TSCMobileConnect.dll` (V: `FileDescription = TSCMobileConnect`), `MobileConnectIntegrationDotNet.dll` (O) |

### 2.3 Recording — `REC`

| ID | Capability | Status | Evidence |
|---|---|---|---|
| REC-01 | Screen video recording | Confirmed | U (Video mode, `Ctrl+Shift+V`) + `VideoRecording.dll`, `RecorderUI.dll`, `CamRec.dll` |
| REC-02 | MP4 container output | Confirmed | `COMPETITOR-A.MP4Format` COM class (O) + `MFMP4Encoder.dll`, `mp4v2.dll` (O). **The specific codec is not established** — these components prove an MP4 muxer and a Media Foundation encoder path, not H.264/AAC. H.264 is the overwhelmingly likely codec but is marked *inferred*. |
| REC-03 | Audio mixing / multiple audio tracks | Confirmed | `AVStreamEncoder.AudioMixer.dll` (O) + `en-US/multi-track.mp4` onboarding video (O) |
| REC-04 | Webcam recording + picture-in-picture | Confirmed | `en-US/record-screen-webcam.mp4` and `en-US/picture-in-picture.mp4` shipped onboarding videos (O, V — vendor-authored tutorial content) |
| REC-05 | **AI background-noise removal** | Confirmed | `deepfilternet3_minimal.onnx` (11.8 MB DeepFilterNet3 speech-enhancement model) + `en-US/remove-background-noise.mp4` (O ×2) |
| REC-06 | **Screen Draw** (annotate live during recording) | Confirmed | `en-US/screen-draw.mp4` (V) |
| REC-07 | Multi-track video editing | Candidate | `VideoEditing.dll` (58.9 KB) + `en-US/multi-track.mp4`. Depth undetermined (§1.4.6). |
| REC-08 | Animated GIF output | Confirmed | `AnimatedGIFDecoder.dll` + `AnimatedGIFSource.dll` + `WpfAnimatedGif.dll` + GifLib declared in `3rdparty_licenses.txt` §2 (O ×3, V) |
| REC-09 | Video preview / playback | Candidate | `MFPreview.dll`, `MediaSrcFilters.dll` (I) |
| REC-10 | Screencast/cloud video publishing | Candidate | `Screencast.dll`, `Competitor BOnline.dll`, `en-US/send-images-to-Competitor B-online.mp4` |

### 2.4 Editing and annotation — `ANN`

The **22 editor tools** below are **confirmed** — each has its own
`EnhancedTooltips/<tool>/ENU/index.html` with a vendor-written `<h2>` title and
description, plus a demo `.mp4` (two artifacts per tool).

| ID | Tool | Vendor description (verbatim, tier V) |
|---|---|---|
| ANN-01 | Arrow Tool | "Add arrows to draw attention to areas in an image. Customize the style in the Properties panel." |
| ANN-02 | Blur Tool | "Add a blur to hide or mask sensitive information." |
| ANN-03 | Callout Tool | "Add annotations to draw attention or to comment on areas in an image. Customize the style in the Properties panel." |
| ANN-04 | Crop Tool | "Remove unwanted areas from the edges of an image." |
| ANN-05 | **Cut Out Tool** | "Delete a vertical or horizontal section of an image. Select a Quick Style to determine the direction and edge style of the cut." |
| ANN-06 | Eraser Tool | "Erase flattened areas in an image to expose the canvas. Right-click the canvas to change its color." |
| ANN-07 | Favorites | "Save your most frequently used tools and Quick Styles as Favorites." **ED-07 confirms it is the first tool-rail entry.** |
| ANN-08 | Fill Tool | "Fill an area with a different color. Use the eyedropper to fill with a specific color from your image." |
| ANN-09 | Highlighter Tool | "Draw attention to a rectangular area in an image. Specify the highlight color and opacity in the Properties panel." |
| ANN-10 | Line Tool | "Add a line to an image. For a curved line select Bezier Curve, draw your line, then click and drag to bend it." |
| ANN-11 | **Magic Wand Tool** | "Select an area in an image based on color. This tool is ideal for selecting areas of a single color that do not include complex backgrounds or patterns." |
| ANN-12 | **Magnify Tool** | "Enlarge and highlight an area. To view both the magnified image and the original, click to select the magnified area, then click and drag the anchor point to the desired location." |
| ANN-13 | More Menu | "Access additional tools or customize your toolbar. Rearrange tools and add additional ones for quicker access." **Confirmed live by ED-06** — the rail shows 10 of 22 tools |
| ANN-14 | Move Tool | "Move existing objects on the canvas, or toggle on **Smart Move** to make static objects editable." |
| ANN-15 | Pen Tool | "Draw freehand lines. Customize the color, shadow, opacity, and width in the Properties panel." |
| ANN-16 | Selection Tool | "Select part of an image to cut, copy, move, or delete. **Automatically replace deleted areas with the surrounding color or transparency.**" |
| ANN-17 | Shape Tool | "Add a shape to an image. Set the Fill color to Transparent to make it a frame." |
| ANN-18 | Share and Engage | "Share Link quickly copies a link to your content to the clipboard. Paste anywhere for team members to view and add feedback. Or click the dropdown for other sharing options." |
| ANN-19 | **Simplify Tool** | "Overlay text and other visual elements with simplified graphics. **Simplified images can reduce distraction, be language-independent, and have a longer lifespan.**" |
| ANN-20 | Stamp Tool | "Annotate your image with stamps from a variety of categories." (2,301 stamps across 9 categories, counted) |
| ANN-21 | Step Tool | "Add steps to illustrate a process or call out specific areas in an image. Click to add numbers or letters sequentially on the canvas." |
| ANN-22 | Text Tool | "Add captions, headings, or other text to an image." (RTF-encoded — `RTFEncodedText` in `.snagx`) |

Three of these descriptions are load-bearing for §4 and are the vendor's own words, not our
reading: **Simplify** is explicitly sold on *language-independence and longer lifespan*
(the G6 argument, verbatim from the vendor); **Selection** performs automatic
surrounding-color infill on delete (ANN-28 inpainting, reachable from the basic
selection tool); and **Move** has a "Smart Move" mode that makes *static, already-flattened*
screenshot elements editable — a capability with no analogue in either PRD.

Supporting capabilities:

| ID | Capability | Status | Evidence |
|---|---|---|---|
| ANN-23 | Step sequence as number, uppercase letter, or lowercase letter | Confirmed | `.snagx` keys `StepToolSequenceNumeric`, `StepToolSequenceUppercaseLetter`, `StepToolSequenceLowercaseLetter` (O) + `"StepSequenceType": "Number"` in `Favorites.json` (O) |
| ANN-24 | Blur type is selectable (Gaussian) with intensity | Confirmed | `"BlurType": "Gaussian"`, `"BlurIntensity"` (O ×2: `Favorites.json`, `Themes/*.snagtheme`) |
| ANN-25 | Drop shadow, opacity, dash type, arrow end caps, gradients per object | Confirmed | `Favorites.json` QuickStyle schema (O) |
| ANN-26 | **Vector (non-destructive) annotations** | Confirmed | `"CreateAsVector": true` (O) + `.snagx` `CaptureObjects[]` with `IsFlattened: false` and separate `CaptureBackgroundImage` PNG (O) |
| ANN-27 | Object lock, priority/z-order, rotation, anchoring | Confirmed | `.snagx` object keys `IsLocked`, `ObjectPriority`, `RotationAngle`, `Anchored` (O) |
| ANN-28 | **Content-aware fill / object erase (inpainting)** | Confirmed | `a vendor module` `FileDescription = "the vendor OpenCv Library (in-painting module)"` (V) + OpenCV `an OpenCV component` (O) |
| ANN-29 | **Smart Redact** | Confirmed | `en-US/smart-redact.mp4` (V) + `a vendor module` "recognition module" (V) |
| ANN-30 | Face detection | Candidate | `haarcascade_frontalface_alt.xml`, `haarcascade_profileface.xml` (O — but Haar cascades are classic OpenCV samples; user-facing use unverified) |
| ANN-31 | Spell checking in text annotations | Confirmed | `dictionaries/` with hunspell `.aff`/`.dic` for de, en-gb, en-us, es, fr, pt + `hunspell-1.7-0.dll` (O ×2) |
| ANN-32 | Watermark | Confirmed | `COMPETITOR-A.ImageWatermark` COM class (O) + `Images/Competitor Awm.png` watermark asset (O) |
| ANN-33 | Border, caption, trim, scale, resolution, color conversion/effects/substitution, filters | Confirmed | `COMPETITOR-A.Image{Border,CaptionOptions,Trim,Scale,Resolution,ColorConversion,ColorEffects,ColorSubstitution,Filters}` (O) + `Images/FilterPreview.PNG` (O) |
| ANN-34 | Undo/redo including over OCR | Confirmed | `a vendor OCR module` (V) |
| ANN-35 | Multi-page documents | Confirmed | `.snagx` `index.json` → `"Pages": [...]` array (O) |
| ANN-36 | **Sections / combine-images canvas** | Confirmed | `.snagx` keys `Sections`, `AddSectionCount`, `ShowSectionGuides`, `DropZoneGroupId` (O) + `Templates/` drag-to-swap and add/delete-section UI PDFs (O) |

### 2.5 OCR and text — `OCR`

| ID | Capability | Status | Evidence |
|---|---|---|---|
| OCR-01 | **Grab Text** (OCR to clipboard/text) | Confirmed | U (preset "Grab Text") + `a vendor OCR module` (O) |
| OCR-02 | OCR engine is **ABBYY FineReader** | Confirmed | `3rdparty_licenses.txt` §14 `"ABBYY FineReader"` (V) + `FREngine.dll`, `Interop.FREngine.dll`, `FREngine.DotNet.Interop.dll`, `AbbyyZlib.dll`, `AbbyyStdFnt.fonts` (O) |
| OCR-03 | Document-layout analysis (paragraphs, tables, columns, lists) | Confirmed | `DocumentAnalysis.{Segmentation,Classification,Objects,ObjectsExtraction,PageServices}.dll` + `Synthesis.*.pat` pattern files named `Paragraphs`, `Tables` (`Tables.clc` 4 MB), `ListItems`, `RunningTitles`, `ParagraphIndents` (O) |
| OCR-04 | Handwriting recognition | Candidate | `Handwrite.clc` (920 KB) (I — ABBYY asset, user-reachability unverified) |
| OCR-05 | OCR languages: English, French, German, Spanish, Portuguese-BR | Confirmed | `{English,French,German,Spanish,PortugueseBrazilian}.{amd,amt}` + `.lm` language models ~32 MB each (O) |
| OCR-06 | **Text is stored in the capture file** | Confirmed | `.snagx` `metadata.json` field `"OcrText"` (O) — the observed value was empty in the bundled sample, so this key alone is one source; corroborated independently by `SnagxProperties.propdesc` + `SnagxPropertyHandler64.dll` (OCR-09), which exist to surface persisted capture text to Windows Search |
| OCR-07 | Neural OCR (end-to-end recognition) | Confirmed | `EndToEndRecognition.dll`, `EndToEnd.Latin.dmd` (5.8 MB), `NeoML.dll` + `NeoMathEngine.dll` (139.7 MB — ABBYY's NeoML), `Normal.cnn` (19.7 MB), `onnxruntime.dll` (O) |
| OCR-08 | Barcode / QR reading | Candidate | `zxing.dll`, `zxing.presentation.dll` (I) |
| OCR-09 | Windows Search indexing of capture text | Confirmed | `Microsoft.Search.Interop.dll` + `SnagxProperties.propdesc` + `SnagxPropertyHandler64.dll` "Snagx Property Handler DLL" (V) — captures are indexed and searchable **from Windows Explorer** |
| OCR-10 | Explorer thumbnails for `.snagx` | Confirmed | `SnagThumbnailProvider.dll` "Competitor A Thumbnail Provider DLL" (V) |

### 2.6 Effects and templates — `EFX`

| ID | Capability | Status | Evidence |
|---|---|---|---|
| EFX-01 | Capture-time Effects pipeline | Confirmed | U (`Effects:` dropdown) + `.snagx` `"Effects": []` array (O) |
| EFX-02 | GPU shader effects (highlight, pixelate) | Confirmed | `HighlightEffect.cso`, `PixelateEffect.cso` compiled shader objects (O) |
| EFX-03 | Image processing effect library | Confirmed | LEADTOOLS: `LtEfxx.dll`, `LtImgEfxx.dll`, `LtImgClrx.dll`, `LtImgCorx.dll`, `LtClrx.dll` (O) |
| EFX-04 | **Themes** (shareable brand kit: colors, fonts, QuickStyles, drop shadow) | Confirmed | `Themes/{Basic,Industrial,Starter}.snagtheme` with keys `QuickStyles`, `ThemeColors`, `FontFamily`, `FontEmphasis`, `DropShadow` (O) + **ED-09 (U): a `Theme:` dropdown sits directly above the Quick Styles gallery in the Editor, so the theme visibly drives the styles you draw with.** This is the decisive evidence for G4. |
| EFX-05 | **Palettes** (shareable color sets) | Confirmed | `Palettes/{Dark,Light} Grayscale.snagpalette` (O) |
| EFX-06 | **Templates** — combine captures into a layout/document | Confirmed | `Templates/` with `NoImage.pdf`, `AddIndicator`, `DeleteSection`, `MoreSection`, `DragToSwap`, `DropToSwap`, `ZoomIn/Out` UI assets in dark+light variants (O) + `en-US/TemplateOnboarding.snagx` (O) + `.snagx` `Sections` model (O) |
| EFX-07 | Templates are localized to de/fr/es/ja/pt | Confirmed | `Templates/Translations.json`, top-level keys `["de","fr","es","ja","pt"]` (O) |
| EFX-08 | Cross-platform document interchange | Confirmed | `.snagx` keys `ExportedFromPlatform` and `metadata.OperatingSystemVersion` (observed value `"macOS 11.6.0"` in a Windows install's bundled sample) (O) |

### 2.7 Output, sharing, formats — `SHR`

| ID | Capability | Status | Evidence |
|---|---|---|---|
| SHR-01 | Share destination selectable at capture time | Confirmed | U (`Share:` dropdown) |
| SHR-02 | Share link | Confirmed | `EnhancedTooltips/share-link-WIN` "Share and Engage" (V) + `en-US/share-link.mp4` (O) |
| SHR-03 | Cloud/service destinations — **components present** | Candidate (see §1.4.2) | `Dropbox.dll`+`Dropbox.Api.dll`, `Box.dll`+`Box.V2.dll`, `GoogleDrive.dll`+`Google.Apis.Drive.v2`, `OneDrive.dll`, `SharePoint.dll`, `Slack.dll`, `MicrosoftTeams.dll`, `YouTube.dll`+`Google.Apis.YouTube.v3`, `OneNote.dll`, `Evernote.dll`, `Twitter.dll`+`Tweetinvi.*`, `Email.dll`+`MimeKit.dll`, `Word.dll`, `Excel.dll`, `Powerpoint.dll`, `Competitor B.dll`, `Competitor BOnline.dll` |
| SHR-04 | **Open in Competitor B Editor** (marked *New!*) | Confirmed | U (preset) + `Competitor B.dll` (O) |
| SHR-05 | FTP output | Candidate | `COMPETITOR-A.FTPOptions` COM class (O) |
| SHR-06 | Email output | Confirmed | `COMPETITOR-A.MailOptions` (O) + `Email.dll`/`MimeKit.dll` (O) |
| SHR-07 | Send to printer | Confirmed | `COMPETITOR-A.PrinterOptions`, `COMPETITOR-A.PrinterPageLayoutOptions` (O) |
| SHR-08 | PDF export | Confirmed | `Export.Pdf.dll`, `PDFLib.dll`, `libhpdf.dll`, `PdfTools.CommonInstruments.dll` (O) |
| SHR-09 | Export to text / word-processor / "Exact" formats | Confirmed | `Export.Txt.dll`, `Export.WP.dll` (1.4 MB), `Export.Exact.dll` (O) |
| SHR-10 | Raster format support: BMP, GIF, JPEG/CMP, PNG, PSD, TIFF, TGA, EPS, RAS, WPG, WMF, FAX | Confirmed | LEADTOOLS codec set `Lf{Bmpx,Gifx,Cmpx,Pngx,Psdx,Tifx,Tgax,Epsx,Rasx,Wpgx,Wfxx,Wmfx,Faxx}.dll` (O) |
| SHR-11 | Per-format save options (GIF, JPEG) | Confirmed | `COMPETITOR-A.Competitor AImageFileTypeOptions{,GIF,JPEG}` COM classes (O) |
| SHR-12 | Extensibility / plugin framework for outputs | Confirmed | `the vendor.ExtensibilityFramework.dll` (V) + `PluginCommon.dll` (O) |

### 2.8 Presets, automation, platform integration — `AUT`

| ID | Capability | Status | Evidence |
|---|---|---|---|
| AUT-01 | **Presets with per-preset global hotkeys** | Confirmed | U (Image `Ctrl+Shift+I`, Video `Ctrl+Shift+V`, Scrolling `Ctrl+Shift+Space`, Grab Text, Step Capture, Open in Competitor B Editor) + `a vendor artifact` and `a vendor artifact` ProgIDs (O) + `a vendor artifact` (O) |
| AUT-02 | Presets/profiles are shareable documents | Confirmed | `a vendor artifact` + `a vendor artifact` ProgIDs registered as document types (O) |
| AUT-03 | **Full COM automation API** (~50 coclasses) | **Confirmed — high value** | `HKLM\SOFTWARE\Classes`: `COMPETITOR-A.Competitor A`, `ImageCapture`, `VideoCapture`, `TextCapture`, `ImageCaptureResults`, `Competitor AImageDocument`, `Competitor AVideoDocument`, `ImageAnnotation`, `TextAnnotation`, `SelectedArea`, `Competitor AOutputImageOptions`, `Competitor AOutputVideoOptions`, + all the `*Options` classes listed above (O) |
| AUT-04 | Command-line switches | Confirmed | UTF-16 string scan of `a vendor artifact`: `/Open "<CaptureFilename>"`, `/name "%s"`, `/help`, `/restartwait`, `/INSTALLSTAMPS`, `/UNINSTALLSTAMPS`, `/IMPORTLASTVERSIONSETTINGS`, `/RETURNLICENSE`, `/tscdev`/`/tscstage`/`/tsclive` (env switches, also `--` forms) (O) |
| AUT-05 | File association `.snagx` → Editor | Confirmed | `HKLM\SOFTWARE\Classes\Competitor A.26.Picture\shell\open\command` = `"…\Competitor AEditor.exe" "%1"` (O) |
| AUT-06 | **Two custom URL protocols** — `com.the vendor.competitor-acapture://` and `com.the vendor.competitor-aeditor://` | Confirmed | `HKLM\SOFTWARE\Classes\com.the vendor.competitor-a{capture,editor}` each carry a `URL Protocol` value, a `DefaultIcon`, and `Shell\open\command` = the respective EXE with `"%1"` (O). Separately `the vendorcompetitor-a` is a **ProgID, not a protocol** (no `URL Protocol` value) that also opens `Competitor AEditor.exe "%1"` (O), and `tscredirect://HELP_TOOLTIP_ARROW` appears as an in-app-only link scheme in `EnhancedTooltips/*/ENU/index.html` (O) with no registered system handler. |
| AUT-07 | Windows Explorer shell extension (context menu) | Confirmed | `Competitor A.MainShellExt` ProgID (O) + `DLLx64/Competitor AShellExt64.dll`, `a vendor artifact` (O) |
| AUT-08 | Scheduled-task integration | **Confirmed** (promoted — see CAP-19) | `Microsoft.Win32.TaskScheduler.dll` (I) + `Presets8.xml` `<ScheduledCaptureTime>` with real values (O) |
| AUT-09 | Windows toast notifications | Confirmed | `Microsoft.Toolkit.Uwp.Notifications.dll` (O) + `Microsoft.WindowsAPICodePack.Shell.dll` (O) |
| AUT-10 | Feature flags / staged rollout | Confirmed | `FeatureSwitch.dll` (O) + `/tscdev`/`/tscstage`/`/tsclive` switches (O) — two independent sources |
| AUT-11 | Crash reporting | Confirmed | Crashpad EXEs + `Crashreporting.dll` + `Backtrace.dll` (O) |
| AUT-12 | Local SQLite store | Candidate | `ltsqlitex.dll` (LEADTOOLS SQLite) (I) |
| AUT-13 | Embedded web UI surfaces | Confirmed | `Microsoft.Web.WebView2.{Core,WinForms,Wpf}.dll` + `WebView2Loader.dll` + declared in `3rdparty_licenses.txt` §17 (O, V) |
| AUT-14 | Self-update via BITS | Confirmed | `TSCUpdater.dll` + `the vendor.OpenApi.UpdaterApi.dll` + `BITSReference5_0.dll` (O) |
| AUT-15 | Auth: MSAL / OIDC / JWT identity stack | Confirmed | `Microsoft.Identity.Client*.dll`, `msalruntime.dll`, `Microsoft.IdentityModel.Protocols.OpenIdConnect.dll`, `System.IdentityModel.Tokens.Jwt.dll`, `Identity-{Common,Services,UI}-Win.dll` (O) |
| AUT-16 | In-product JTBD survey | Confirmed | `Surveys/JtbdSurvey.json` — 10 answer options incl. "Create user documentation or technical guides", "Report technical issues or bugs", "Create training or tutorial content" (O). **This is the vendor's own persona framing** and is useful input for `persona-discovery`. |

### 2.8a Preset schema (read from the live user profile)

Source: `%LOCALAPPDATA%\the vendor\Competitor A\Presets8.xml` (O, read-only; `Presets7.xml` also
present as prior-version residue). Root `<SavedPresets>`, `<Version>8</Version>`, containing
`<AllInOne>`, `<Image>`, `<Video>`, `<OneClick>` archetypes plus a `<Presets>` list. The
user's six visible presets are confirmed here by `<DisplayName>`: `All-in-One`, `Image`,
`Video`, `Scrolling Capture`, `Grab Text`, `Step Capture`, `Open in Competitor B Editor` —
matching the screenshot exactly (U + O, independent).

**A preset bundles ~110 distinct settings.** The grouping, verbatim from element names:

| Group | Elements |
|---|---|
| Identity | `DisplayName`, `IsDefault`, `AutoGenerateName`, `HotKey`, `HotKeyModifiers` |
| Mode | `CaptureMode`, `SelectionMode`, `SelectionSettingsRegion{RegionSelectionType, Region{Left,Top,Width,Height}, SetPosition}` |
| Capture options | `CaptureCursor`, `CaptureEffects`, `CopyToClipboard`, `PreviewInEditor`, `TimeDelay`, `DelayDuration` |
| **Timed / interval capture** | `TimedCaptureType` (observed value `Delay`), `ScheduledCaptureTime`, `IntervalDuration`, `IntervalUnits`, **`IntervalDiscardIdentical`** |
| **Recording sources** | `EnableSystemAudio`, `EnableMicrophone`, `SelectedMicrophone`, `EnableWebcam`, `SelectedWebcamDevice`, `SelectedWebcamPlacement`, `StartWebcam`, `PipShape` (observed `Circle`), `MultiTrackMode` (observed `None`, `TREC`), `EnableBackgroundNoiseRemoval` |
| **Cursor / click emphasis** | `CursorHighlightEnabled`, `CursorHighlightColor`, `ClickAnimationEnabled`, `ClickAnimationColor` |
| **Screen Draw** | `ScreenDrawStartsOn`, `ScreenDrawFadeDelay` |
| Share | `ShareDestinationIds[]`, `ShareSettings{File, FileSave, Email, Ftp, Program}`, `ShareAutoNameSettings{FileFormat, Prefix, Digits, StartNumber, Overwrite}`, `OpenInDisplayText`, `OpenInDisplayIcon` |
| Output format | `OutputFileType`, `SubFileType`, `BitsPerPixel`, `Quality`, `TransparencyEnabled`, `IsMultipage`, `Pdf{PageSize,PageWidth,PageHeight,Landscape,ImageLayout,Margin*}` |
| Device availability | `DevicePath`, `Availability` (per capture device) |

Capabilities this **newly established or corrected**:

| ID | Capability | Status | Evidence |
|---|---|---|---|
| AUT-01a | A preset is a named, hotkeyed, ~110-field record | Confirmed | `Presets8.xml` (O) + U (rail) |
| REC-11 | **Cursor highlight and click-ripple animation, with configurable colors** | Confirmed | `Presets8.xml` `CursorHighlightEnabled`/`CursorHighlightColor`/`ClickAnimationEnabled`/`ClickAnimationColor` (O). **This corrects §3.2, which recorded FR-REC.6 as having no Competitor A analogue.** |
| CAP-18 | **Interval / time-lapse capture with identical-frame discard** | Confirmed | `TimedCaptureType`, `IntervalDuration`, `IntervalUnits`, `IntervalDiscardIdentical` (O) |
| CAP-19 | **Scheduled capture at an absolute time** | Confirmed | `ScheduledCaptureTime` with real ISO-8601 values (O); corroborates AUT-08 (`Microsoft.Win32.TaskScheduler.dll`) — AUT-08 is hereby **promoted candidate → confirmed** |
| REC-12 | Webcam placement + PiP shape are preset-level settings | Confirmed | `SelectedWebcamPlacement`, `PipShape` (O) + REC-04 (V) |
| REC-13 | Recording can target Competitor B's multi-track `.trec` format | Confirmed | `MultiTrackMode` observed value `TREC` (O) + SHR-04 (U) |
| SHR-13 | **Auto-naming scheme for outputs** (`<Prefix><AutoNum>`, `SNAG-`, 4 digits, overwrite policy) | Confirmed | `ShareAutoNameSettings` (O) |
| SHR-14 | **"Send to Program"** — an arbitrary external application as an output | Confirmed | `ShareSettingsProgram` (O) + `ProgramOutputs.xml` in the same directory (O) |
| SHR-15 | PDF page layout control (size, orientation, margins, image layout, multipage) | Confirmed | `Pdf*` element group (O) + SHR-08 (O) |
| ANN-37 | Tool/QuickStyle customization persists per user | Confirmed | `Tools2.xml` (104.5 KB), `ImageQuickStylesV2.xml`, `GifExportOptions.xml` in the same directory (O) |
| CAP-20 | A **"OneClick"** capture archetype exists alongside All-in-One/Image/Video | Candidate | `<OneClick>` element in `Presets8.xml` (O), single source |

### 2.9 Localization and accessibility — `LOC` / `A11Y`

| ID | Capability | Status | Evidence |
|---|---|---|---|
| LOC-01 | UI localized to **6 locales**: en-US, de-DE, es-ES, fr-FR, ja-JP, pt-BR | Confirmed | Top-level locale dirs (O) + `EnhancedTooltips/*/{ENU,DEU,ESN,FRA,JPN,PTB}` per tool (O) |
| LOC-02 | Localized onboarding video/tutorial content, not just strings | Confirmed | `en-US/*.mp4` (16 tutorial videos) mirrored per tooltip locale (O) |
| LOC-03 | RTL/complex text shaping | Candidate | `fribidi-0.dll`, `harfbuzz.dll`, `pango*` (I — could be internal rendering only) |
| A11Y-01 | UI Automation client interop present | Candidate | `Interop.UIAutomationClient.dll` (I). **A UIA *client* assembly is for reading other apps' trees, not for exposing your own.** Whether Competitor A's own UI is accessible was not determined. |
| A11Y-02 | Enhanced tooltips are HTML+video with a "Learn More" link | Confirmed | `EnhancedTooltips/*/ENU/index.html` + `main.css` + `scripts.js` (O) |
| A11Y-03 | Screen-reader support / keyboard-complete operation | ∅ | Not determinable statically; app not launched |

### 2.10 Data model (reconstructed)

**`.snagx` = ZIP container.** (O: `zipfile` open succeeded on `en-US/EditorOverview.snagx`.)

```
capture.snagx (ZIP)
├── index.json        { "Pages": ["{GUID}.json"], "Version": "1.0" }   ← multi-page
├── metadata.json     { AppName, AppVersion, CalloutText, CaptureDate,
│                       LanguageCode, OcrText, OperatingSystemVersion,
│                       Version, WebURL, WindowName }
├── thumbnail.png
└── {GUID}.json       ← one page document
    ├── CaptureBackgroundImage → {GUID}.png   (the original pixels, preserved)
    ├── CaptureCanvasWidth/Height, DPI, CaptureColorSpace (base64 ICC profile)
    ├── CaptureObjects[]  ← vector annotation objects
    │     { ObjectID (GUID), StartPoint, EndPoint, PointsArray[],
    │       ForegroundColor, BackgroundColor, Opacity, DashType,
    │       DropShadowEnabled, Shadow{Color,Blur,Opacity,DirectionX/Y},
    │       FontFamily, FontSize, RTFEncodedText (base64 RTF),
    │       PlaceholderText, RotationAngle, AspectRatio, Anchored,
    │       IsLocked, IsFlattened, ObjectPriority, IgnoresUndoAll,
    │       DropZoneGroupId }
    ├── Effects[], Sections[], SimplifySettings{ IsLocked, ShowOriginal,
    │                                            SimplifyOpacity, SuiDetail }
    └── StepToolSequence{Numeric,UppercaseLetter,LowercaseLetter}
```

**The finding that matters for Nawi:** `metadata.json` already carries
**`WebURL`, `WindowName`, `AppName`, `AppVersion`, `OperatingSystemVersion`,
`LanguageCode`, and `OcrText`.** Competitor A is not purely a pixel tool — it persists a small
amount of provenance and extracted-text state alongside the image, and exposes it to
Windows Search via `SnagxProperties.propdesc`. This is a **much thinner** thing than
PRD-001's state layer (no DOM, no a11y tree, no console, no HAR, no input events, no
timestamps), but it is not nothing, and §5 is worded accordingly.

**QuickStyle schema** (`Favorites.json`, `Themes/*.snagtheme`) is a flat ~55-key style
record shared across all tools — one schema, `ToolMode` discriminates.

### 2.11 Non-functional baseline (factual, not evaluated)

- **Runtime:** mixed native C++ (MFC 14 — `mfc140u.dll`) and .NET Framework 4.7.2
  (`MobileConnectInterop.Net472.dll`), WPF (`WPFCommonControls.dll`,
  `Microsoft.Xaml.Behaviors.dll`) and WinForms (`the vendor.WinForms.dll`), with WebView2
  for some surfaces.
- **DI containers:** three ship — `Autofac.dll`, `DryIoc.dll`,
  `Microsoft.Extensions.DependencyInjection.dll`, plus the deprecated
  `Microsoft.Practices.ServiceLocation.dll`. Multiple DI containers in one process is
  evidence of long-lived accreted architecture. Recorded as an observation.
- **Install size drivers:** `NeoMathEngine.dll` 139.7 MB, `Microsoft.Graph.dll` 38.9 MB,
  three ~32 MB OCR language models, `opencv_imgproc480.dll` 27.2 MB, `Normal.cnn` 19.7 MB,
  `Image.Services.Core.dll` 15.8 MB, `ocr.zmd` 14.2 MB, `onnxruntime.dll` 14.0 MB.
  **The ML/OCR stack is the dominant cost of the install.**
- **Third-party, vendor-declared** (`3rdparty_licenses.txt`): Chromium, GifLib, FreeType,
  libpng, libyuv, ABBYY FineReader, Google Fonts, zlib, Microsoft WebView2, OpenSSL,
  Websocket++, Boost, Intel. Plus (O, from filenames) LEADTOOLS, OpenCV 4.8.0, ONNX
  Runtime, hunspell, ZXing, BouncyCastle, Newtonsoft.Json, RestSharp, MimeKit, Tweetinvi.
- **Deployment:** MSI (`a package manifest` `tagId="msi:package/…"`, WiX declared in licenses),
  per-machine `Program Files`, live printer device installed, shell extension registered,
  ~50 COM classes registered machine-wide.

---

### 2.12 Competitor A Editor UI (tier U — user-supplied screenshot)

Source: a second user-supplied screenshot, title bar
`2026-08-28_15-09-21.snagx - Competitor A Editor`. **Everything in this subsection is tier U**
unless a corroborating source is named. Until now the Editor was known only from the
install tree (`a vendor artifact`, `EditorDotNet.dll`, `EditorInterop.dll`,
`a vendor artifact`) — i.e. we knew it existed and roughly how big it was, and nothing
about its surface. This is the single largest reduction in §1.4 uncertainty in the document.

| ID | Observation | Status | Notes / corroboration |
|---|---|---|---|
| ED-01 | Menu bar: File, Edit, **Image**, **Video**, Share, View, Help | Confirmed (U) | **Image and Video are separate top-level menus** — the editing surface is mode-dependent on the asset type, not one unified canvas menu |
| ED-02 | Mode tabs, top-left: **Editor \| Library \| Assets \| Capture \| Create** | Confirmed (U) | Five peer modes in one window |
| ED-03 | `Capture` is a tab *inside* the Editor | Confirmed (U) | Capture host and Editor are mutually reachable, not a one-way post-capture handoff. Corroborates AUT-06 (both EXEs have their own URL protocol) |
| ED-04 | **`Assets`** tab carries an external-link glyph | Candidate (U) | Reads as an online/downloadable asset library (stamps, templates, themes) rather than a local panel. Its being external is the observation; what it contains is **inferred** |
| ED-05 | **`Create`** is its own top-level mode | Confirmed (U) | Almost certainly the combine-images/template surface recorded as ANN-36 / EFX-06 / G2. That mapping is **inferred**; that the mode exists is observed |
| ED-06 | Tool rail (horizontal, top-centre): Favorites, Arrow, Text, Callout, Shape, Stamp, Fill, Move, Selection, More — then Undo, Redo | Confirmed (U) | Ten visible entries out of the 22 tools in §2.4. **Confirms ANN-13 ("More Menu") is a real overflow affordance, and confirms the §6 handoff note that Competitor A outgrew its own toolbar** |
| ED-07 | **Favorites is itself a tool-rail entry**, in first position | Confirmed (U + `Favorites.json`, O) | Cross-tool saved-style access is a first-class rail item, not a menu |
| ED-08 | **Move and Selection are separate tools** | Confirmed (U + ANN-14/ANN-16 vendor descriptions, V) | Move = reposition objects (+ "Smart Move"); Selection = cut/copy/delete regions of the image with auto-infill |
| ED-09 | Right panel, top: **"Quick Styles"** — a `Theme:` dropdown (value `Basic`) above a gallery of **12 preset arrow styles** | Confirmed (U + `Themes/Basic.snagtheme` `QuickStyles[]`, O) | The gallery is **per-tool** (arrow styles while Arrow is active) and is **bound to the selected theme** |
| ED-10 | Right panel, middle: **"Tool Properties"** with a `?` help affordance | Confirmed (U) | Contents for Arrow: Color swatch; **Shadow as a direction picker, not a boolean**; line-style dropdown; arrowhead-style dropdown; Width (10), Opacity (100), **Start Size (3)**, **End Size (3)** sliders each with a numeric field; **Bezier Curve** checkbox |
| ED-11 | Right panel, bottom: **"Select All (Arrow)"** button | Confirmed (U) | Select every object of the *currently active tool type* |
| ED-12 | Bottom bar: "Hide Recent" toggle, **Tag** button, zoom (100%), canvas dimensions (1467 x 549px), **Effects** and **Properties** panel toggles | Confirmed (U) | Tagging is an editor-level action on the open capture, not only a library-level one |
| ED-13 | **Persistent recent-captures filmstrip** along the bottom, one thumbnail carrying a video duration badge (`00:06`) | Confirmed (U) | **Images and videos share one tray**, and it is always visible while editing — distinct from the Library grid (ED-02), which is a separate mode |
| ED-14 | Top-right: **Copy All**, and **Share Link** as a split button with a dropdown | Confirmed (U + ANN-18 vendor description, V) | ANN-18's text — "quickly copies a link… Or click the dropdown for other sharing options" — describes exactly this control |
| ED-15 | Canvas has eight resize handles and is letterboxed within its frame | Confirmed (U) | The **canvas is resizable independently of the image** — consistent with `.snagx` `CaptureCanvasWidth/Height` being stored separately from the background image (§2.10, O), and with ANN-06's "erase… to expose the canvas" (V) |
| ED-16 | Title bar shows the open document as `….snagx` | Confirmed (U + AUT-05, O) | **The Editor's document model is the single-file `.snagx` project**, not an opaque library entry — see G16 |

**Effects/Properties as toggleable panels** (ED-12) corroborates EFX-01: `Effects` is a
persistent panel in the Editor, not only the capture-time dropdown seen in the first
screenshot.

## 3. The three-way matrix

Legend for **Nawi today**: a `path` = implemented and cited. `no` = no
implementation found in `src/`. Column 3 is cited from source, **not** from README prose.

### 3.1 Capture

| Capability | Competitor A | Our PRD | Nawi today |
|---|---|---|---|
| Region capture | CAP-02 | FR-CAP.1 P0 / UX-CAP.3 | `src/shared/ipc.ts:6` `capture:begin-region`; `src/main/capture.ts:37` `dipRectToPixels` |
| Full-screen capture | CAP-02 | FR-CAP.1 P0 | `src/shared/ipc.ts:4`; `src/main/capture.ts:82` `captureDisplay` |
| Window capture | CAP-02 | FR-CAP.1 P0 | `src/shared/ipc.ts:5`; `src/main/capture.ts:121` `captureWindowSource` |
| Multi-monitor / mixed DPI | CAP-02 (I) | FR-CAP.2 P0 | `src/main/capture.ts:12` `listDisplays`, `:111` `captureAllDisplays`, `:37` DIP→px |
| Clipboard on capture | CAP-06 | FR-CAP.3 P0 | `src/shared/ipc.ts:26` `export:clipboard`; `src/main/index.ts:516` |
| Freeze-screen selection | ∅ (not determinable) | FR-CAP.4 P0 / UX-CAP.1 | `src/main/capture.ts:111` + `src/renderer/overlay.tsx` (freeze-frame overlay) |
| Element-aware capture | CAP-15 **candidate** | FR-CAP.5 P0 / UX-CAP.4 | `src/main/cdp/probe.ts:88` `rankSelectorsFor`; MCP `capture_element` `src/main/mcp/tools.ts:278` |
| **Scrolling capture** | **CAP-03 confirmed** | FR-CAP.6 **P1** | **no** |
| Delayed capture | CAP-04 | FR-CAP.7 P1 | **no** |
| Repeat-last-region | ∅ | FR-CAP.7 P1 / UX-CAP.6 | **no** |
| Output scaling | ANN-33 (`ImageScale`) | FR-CAP.8 P1 | **no** |
| Cursor include/exclude | CAP-05 | **not in PRD** — see §4 | **no** |
| **Print capture (virtual printer)** | **CAP-09 confirmed** | **not in PRD** — §4 | **no** |
| TWAIN / scanner | CAP-10 candidate | not in PRD | **no** |
| **Interval / time-lapse capture with identical-frame discard** | CAP-18 | **not in PRD** — §4 | **no** |
| **Scheduled capture at an absolute time** | CAP-19 | **not in PRD** — §4 | **no** |
| Auto-crop (ML) | CAP-16 candidate | not in PRD | **no** |
| Mobile device capture | CAP-17 candidate | out of scope (PRD-001 §3) | **no** |

### 3.2 Recording

| Capability | Competitor A | Our PRD | Nawi today |
|---|---|---|---|
| Screen recording | REC-01 | FR-REC.1 P0 | `src/shared/ipc.ts:16-17`; `src/renderer/lib/recorder.ts` |
| System audio | REC-03 | FR-REC.1 P0 | `src/renderer/lib/recorder.ts:17` (opus tracks); Windows-only |
| Microphone / webcam tracks | REC-04 | FR-REC.1 P0 | **no** |
| Pause / resume | ∅ | FR-REC.2 P0 | **no** |
| Crash-safe recording recovery | ∅ (Crashpad ≠ this) | FR-REC.3 P0 | **no** |
| **MP4 (H.264/AAC) output** | **REC-02 confirmed** | FR-REC.4 P0 | **no** — WebM only, `src/renderer/lib/recorder.ts:17-21` |
| GIF output | REC-08 | FR-REC.4 P1 | **no** |
| Ring buffer / save-last-N | ∅ | FR-REC.5 P1 | **no** |
| Cursor smoothing / click ripple / auto-zoom | **REC-11 — cursor highlight + click ripple confirmed** (auto-zoom: ∅) | FR-REC.6 P1 | **no** |
| Keystroke overlay | ∅ | FR-REC.7 P1 | **no** |
| Chapter markers | ∅ | FR-REC.8 P1 | **no** |
| **AI noise removal** | **REC-05 confirmed** | **not in PRD** — §4 | **no** |
| **Screen Draw while recording** | **REC-06 confirmed** | **not in PRD** — §4 | **no** |
| **Picture-in-picture / webcam overlay** (placement + PiP shape) | **REC-04, REC-12 confirmed** | **not in PRD** — §4 | **no** |
| Record directly to Competitor B `.trec` multi-track | REC-13 | not in PRD | **no** |
| Multi-track video timeline | REC-07 candidate | FR-ANN.6 P1 (partial) | **no** |

### 3.3 Annotation and editing

| Capability | Competitor A | Our PRD | Nawi today |
|---|---|---|---|
| Arrow | ANN-01 | FR-ANN.1 P0 / UX-ANN.1 `A` | `src/renderer/components/EditorView.tsx:12` |
| Rectangle | ANN-17 | FR-ANN.1 P0 `R` | `EditorView.tsx:13` |
| Ellipse | ANN-17 | FR-ANN.1 P0 `E` | `EditorView.tsx:14` |
| Text | ANN-22 | FR-ANN.1 P0 `T` | `EditorView.tsx:15`, `:304` |
| Highlighter | ANN-09 | (implied FR-ANN.1) `H` | `EditorView.tsx:16` |
| Blur / pixelate | ANN-02, ANN-24 | FR-ANN.3 P0 `B`/`P` | `EditorView.tsx:17`, `:280` (`mode: 'pixelate'`) |
| Numbered step badge | ANN-21, ANN-23 | FR-ANN.1 P0 / UX-ANN.2 `N` | `EditorView.tsx:18`, `:309` |
| Crop | ANN-04 | FR-ANN.5 P1 `C` | `EditorView.tsx:19`, `:298` |
| Freehand / pen | ANN-15 | FR-ANN.1 P0 | **no** |
| **Callout** (shaped speech bubble with tail) | **ANN-03 confirmed** | FR-ANN.1 P0 "text callout" — but no tail/shape model | **no** — plain text only |
| Line | ANN-10 | not explicitly in PRD | **partial — model only**: `'line'` is in `ShapeKind` (`src/shared/types.ts:132`) and `SimpleShape` (`:174`), but **no line entry exists in the tool rail** (`EditorView.tsx:10-19`). Recorded as a finding in §4.3, not a defect claim. |
| Fill | ANN-08 | not in PRD | **no** |
| Eraser | ANN-06 | not in PRD | **no** |
| Selection / move | ANN-16, ANN-14 — **two separate tools, ED-08** | not in PRD | `EditorView.tsx:8` `'select'` (annotation select only; no image-region selection, no object move tool, no auto-infill on delete) |
| **Magic wand** | ANN-11 | not in PRD | **no** |
| **Magnify** | ANN-12 | FR-ANN.5 P1 "magnifier inset" | **no** |
| **Cut Out** | ANN-05 | **not in PRD** — §4 | **no** |
| **Simplify** | ANN-19 | **not in PRD** — §4 | **no** |
| **Stamps (2,301 assets)** | ANN-20 | **not in PRD** — §4 | **no** |
| **Content-aware fill / inpainting** | ANN-28 | **not in PRD** — §4 | **no** |
| Spotlight / dim | ∅ | FR-ANN.5 P1 `S` | **no** |
| Non-destructive vector annotations | ANN-26 | FR-ANN.2 P0 | `src/shared/types.ts:180` `AnnotationDoc`; `src/shared/ipc.ts:22` `library:save-annotations` |
| Destructive redaction on export | ANN-29 (Smart Redact) | FR-ANN.3 P0 / UX-ANN.4 | `src/main/mcp/tools.ts:551` `redact`; `src/main/harvest/snapshot.ts:42` `SNAPSHOT_SENTINEL` |
| Auto-contrast callout color | ∅ | FR-ANN.4 P1 / UX-ANN.5 | **no** |
| **Brand kit / theme** | **EFX-04, EFX-05, ED-09** | FR-ANN.7 P1 — **export-only by UX-VIS.5** | **no** |
| **Per-tool Quick Styles gallery bound to a theme** | **ED-09** | **not in PRD** — §4 (G17) | **no** — `EditorView.tsx` has a flat colour/stroke palette, no named styles |
| **Annotation drop shadow (with direction)** | **ED-10**; `Favorites.json` `DropShadowEnabled`/`ShadowColor`/`ShadowBlur`/`ShadowOpacity`/`ShadowDirectionX/Y` (O) | **not in PRD** — §4 (G18) | **no** — absent from `src/shared/types.ts` *and* from `ARCHITECTURE.md` §5 |
| **Bezier-curve arrows** | **ED-10** (checkbox); ANN-10 vendor text (V) | **not in PRD** — §4 (G18) | **no** — `curve?: Point` is in `docs/ARCHITECTURE.md:371` but **not** in the shipped `SimpleShape` (`src/shared/types.ts:174`) |
| **Independent start/end arrowhead sizes** | **ED-10**; `Favorites.json` `ArrowStartWidth`/`ArrowEndWidth`/`ArrowStart`/`ArrowEnd` (O) | **not in PRD** — §4 (G18) | **no** — `ARCHITECTURE.md:370` has a single `headSize`; shipped model has neither |
| **Per-annotation opacity and dash style** | ED-10; `Favorites.json` `Opacity`/`DashType` (O) | **not in PRD** | **no** — in `ARCHITECTURE.md:365` `StrokeStyle{opacity, dash}` but **not** in the shipped `BaseShape` (`src/shared/types.ts:149-158`) |
| **Select all objects of the active tool type** | **ED-11** | **not in PRD** — §4 (G19) | **no** |
| Undo/redo ≥50 | ANN-34 | UX-ANN.6 P1 | `EditorView.tsx` `commit()` history (depth not asserted) |
| Video trim/cut/silence removal | REC-07 candidate | FR-ANN.6 P1 | **no** |
| **Multi-page document** | **ANN-35** | **not in PRD** — §4 | **no** — one asset per library item |
| **Combine images / sections / templates** | **ANN-36, EFX-06** | **not in PRD** — §4 | **no** |
| **Watermark** | ANN-32 | **not in PRD** — §4 | **no** |
| **Border / caption / shadow / effects** | ANN-25, ANN-33, EFX-01-03 | partially FR-ANN.7 | **no** |
| **Spell check in text** | ANN-31 | not in PRD | **no** |

### 3.4 OCR, text, search

| Capability | Competitor A | Our PRD | Nawi today |
|---|---|---|---|
| OCR of captures | OCR-01, OCR-02, OCR-07 | FR-AI.2 P0 | **no** |
| OCR text persisted in the file | OCR-06 | DC-4 `derived.ocr` | **no** |
| Multi-language OCR | OCR-05 | not specified in PRD | **no** |
| Document layout reconstruction (tables, paragraphs) | OCR-03 | **not in PRD** — §4 | **no** |
| Text capture from window objects (non-OCR) | CAP-11 candidate | **not in PRD** — §4 | **no** |
| Library search | OCR-09 | FR-AI.5 P1 (semantic) | `src/shared/ipc.ts:19` `library:list`; MCP `search_captures` `src/main/mcp/tools.ts:420` |
| **Capture tagging from the editor** | **ED-12** (Tag button in the bottom bar) | **covered as a concept** — PRD-002 §2 IA "Folders, tags, collections"; FR-SHR.5 P1; FR-AI.4 P1 auto-tagging | **model only** — `LibraryItem.tags?` exists (`src/shared/types.ts:121`) and MCP `search_captures` searches it (`src/main/mcp/tools.ts:435`), but **no UI writes it**. See §4.3. |
| **Persistent recent-captures tray, images + video, always visible while editing** | **ED-13** | **partially covered** — PRD-002 §2 IA line 50 puts "recent 5" in the **OS menu bar/tray**, a different surface | **no** | 
| **OS-level search integration (Windows Search)** | **OCR-09 confirmed** | **not in PRD** — §4 | **no** |
| **OS-level thumbnails for our file type** | **OCR-10 confirmed** | **not in PRD** — §4 | **no** |
| Transcription | ∅ (no ASR model found; only DeepFilterNet denoiser) | FR-AI.1 P0 | **no** |
| Sensitive-data detection | ANN-29 Smart Redact | FR-AI.3 P0 | partial — secret-field suppression only: `src/main/cdp/probe.ts:26` `SECRET_MARKER_ATTRIBUTE`, `:128` `markAndResolveSecrets`; `src/main/harvest/snapshot.ts:130` `filterSecretsFromSnapshot`; `src/main/harvest/har.ts:25` `STRIPPED_HEADERS` |

### 3.5 Sharing and output

| Capability | Competitor A | Our PRD | Nawi today |
|---|---|---|---|
| Share link at capture completion | SHR-02 | FR-SHR.1 P0 / UX-REC.4 | **no** |
| Link controls (expiry, password, domain) | ∅ | FR-SHR.2 P0 | **no** |
| Comments / analytics / shared libraries | ∅ | FR-SHR.3-5 P1 | **no** |
| Slack | SHR-03 candidate | FR-INT P0 | **no** |
| GitHub Issues | ∅ | FR-INT P0 | **no** |
| Clipboard / filesystem | SHR-10, CAP-06 | FR-INT P0 | `src/shared/ipc.ts:25-28` |
| PNG / JPEG export | SHR-10 | implied | `src/main/index.ts:385-395` (`png`/`jpg`/`webm`) |
| **PDF export** | **SHR-08** | FR-GDE.3 P1 (guides only) | **no** |
| **Broad raster format matrix (13 codecs)** | **SHR-10** | not in PRD | **no** — 2 formats |
| Email / FTP / printer output | SHR-05-07 | not in PRD (legacy) | **no** |
| Office (Word/Excel/PPT/OneNote) | SHR-03 candidate | FR-INT P2 (Google Docs) | **no** |
| **Open in Competitor B Editor** | **SHR-04 (U, *New!*)** | not in PRD | **no** |
| Output plugin framework | SHR-12 | not in PRD | **no** |
| **Auto-naming scheme for saved output** (`SNAG-0001`…) | SHR-13 | **not in PRD** — §4 | **no** |
| **"Send to Program"** — arbitrary external app as an output | SHR-14 | not in PRD | **no** |

### 3.6 Presets, automation, platform

| Capability | Competitor A | Our PRD | Nawi today |
|---|---|---|---|
| Global hotkeys | AUT-01 | FR-CAP.1 P0 | `src/main/index.ts:584` `registerShortcuts`; defaults `src/shared/settings.ts:73-78` |
| **Named presets bundling every capture setting + own hotkey** | **AUT-01 confirmed (U)** | **not in PRD** — §4 | **no** — 6 fixed actions only |
| Shareable/exportable presets | AUT-02 | not in PRD | **no** |
| **Programmatic API** | **AUT-03 COM, ~50 coclasses** | FR-AGT.1 P0 (MCP) | `src/main/mcp/tools.ts` — all 12 FR-AGT.1 tools present: `capture_screen:198`, `capture_region:230`, `capture_element:278`, `start_recording:311`, `stop_recording:325`, `get_capture:339`, `get_state_layer:351`, `list_captures:394`, `search_captures:420`, `annotate:464`, `redact:551`, `export_guide:583` |
| CLI switches | AUT-04 | FR-CLI.1-4 P1/P2 | **no** — `src/mcp/stdio-bridge.ts` is an MCP transport, not a CLI |
| File association + custom URL protocol | AUT-05, AUT-06 | not in PRD | **no** (`capture://` is internal-only, `src/shared/ipc.ts:41`) |
| **Shell / Explorer context-menu extension** | **AUT-07** | **not in PRD** — §4 | **no** |
| OS notifications | AUT-09 | UX-NTF.1-3 | **no** |
| Feature flags | AUT-10 | not in PRD | **no** |
| Crash reporting | AUT-11 | not in PRD | **no** |
| Auto-update | AUT-14 | not in PRD | **no** |
| SSO / OIDC identity | AUT-15 | FR-SEC.5 P1 | **no** |
| Agent kill switch | ∅ (n/a) | UX-AGT.3 P0 | `src/shared/ipc.ts:34-37`; `src/renderer/components/AgentAccessToggle.tsx` |
| Dark/light theme | EFX-04 (asset themes ≠ UI theme) | UX-VIS.3 P0 | `src/renderer/lib/theme.ts`; `ThemeToggle.tsx` |
| Localization | LOC-01 (6 locales) | **not in PRD** — §4 | **no** |

### 3.7 State layer (PRD-001 §5) — the asymmetric column

| Capability | Competitor A | Our PRD | Nawi today |
|---|---|---|---|
| DOM snapshot | **no** | FR-STA.1 P0 | `src/main/harvest/snapshot.ts:79` `CapturedSnapshot` |
| Accessibility tree | **no** (UIA client present, CAP-15, use unverified) | FR-STA.2 P0 | `src/main/harvest/snapshot.ts:357` `buildAxTree`, `:241` `AxNodeOut` |
| Console log capture | **no** | FR-STA.3 P0 | `src/main/harvest/harvest.ts` + `inject/listener.js` |
| Input events with ranked selectors | **no** | FR-STA.4, FR-STA.6 P0/P1 | `src/main/cdp/selectors.ts`; `src/main/cdp/probe.ts:88` |
| Network HAR | **no** | FR-STA.5 P1 | `src/main/harvest/har.ts:109` `HarEntry`, `:18` 256 KB cap |
| Monotonic timestamp alignment | **no** | FR-STA.7 P1 / DC-1 | `src/main/cdp/clock.ts` |
| Window/app/URL metadata | **partial — `metadata.json` `WebURL`, `WindowName`, `AppName`** | DC-4 `surface{}` | `src/shared/sidecar/types.ts` |
| Atomic revisioned sidecar | **no** | DC-6 | `src/main/sidecar/writer.ts`, `src/main/sidecar/seal.ts`, `src/main/mcp/revision.ts` |
| Field projection for token budget | **no** | FR-AGT.2 P0 | `src/main/mcp/projection.ts` |

---

## 4. Gaps in OUR PRD that Competitor A reveals

Capabilities Competitor A ships that **PRD-001 and PRD-002 never mention**. Priority column is a
**recommendation for `product-manager` to accept or reject**, not a decision.

### 4.1 Matters — these are real gaps

| # | Gap | Competitor A evidence | Why it matters | Rec. |
|---|---|---|---|---|
| G1 | **Presets as a first-class object** — a named bundle of (mode + selection + effects + share + toggles + capture-source devices + output naming) with its **own global hotkey**, saveable and shareable | AUT-01, **AUT-01a (the live `Presets8.xml`, ~110 distinct elements, §2.8a)**, AUT-02 | This is Competitor A's *entire* power-user story and it's the visible centrepiece of the capture window. Our PRD has six hardcoded action hotkeys (`settings.ts:73-78`) and no composition. It is also the natural unit an **agent** would name in an MCP call (`capture_with_preset("bug-report")`) — it's a differentiator adjacent to FR-AGT, not just parity. | **P0/P1** |
| G2 | **Combine images / multi-page / sections / templates** | ANN-35, ANN-36, EFX-06 | A whole product mode we have no analogue for. It is also the *manual* version of what FR-GDE.1 automates — a user who wants a 6-panel doc without recording a session has nowhere to go in our PRD. | **P1** |
| G3 | **Callout as a shaped object with a tail**, not "text" | ANN-03; `Favorites.json` `CalloutShape: "CTRoundedRectWithArrow"`, `CalloutTails[]`, `TailStyle`, `TailHeadStyle`, `TailWidth`, `TailColor` | FR-ANN.1 says "text callout" and our implementation renders plain text (`EditorView.tsx:15`). The tail — pointing the bubble *at* something — is the actual feature. Cheap; high perceived-quality delta. | **P1** |
| G4 | **Brand kit exists in our PRD (FR-ANN.7 P1) but as export-only.** Competitor A's Themes/Palettes are *authoring* objects — they change the tools you draw with. | EFX-04, EFX-05, ANN-07 (Favorites) | UX-VIS.5 explicitly says brand kits apply to exports only and never to app chrome. That's a defensible stance for *chrome*, but Competitor A's model applies the kit to the **annotation defaults**, which is different and is what users actually want. Worth an explicit decision rather than an accidental omission. | **P1** |
| G5 | **Stamps / a sticker library** | ANN-20, 2,301 assets in 9 categories | Trivially skippable as "clip art," but the `Interface` category alone has 647 assets — those are UI glyphs (cursors, buttons, arrows) for documentation. Directly serves the "create user documentation" JTBD that the vendor's own survey ranks first (AUT-16). | **P2** (curated subset, not 2,301) |
| G6 | **Simplify** — replace real UI with abstract placeholder shapes | ANN-19; `Simplify/` 7 SUI assets; `.snagx` `SimplifySettings.SuiDetail` | A genuinely clever privacy+longevity feature: a simplified screenshot doesn't leak data and doesn't go stale on a UI restyle. That second property is *precisely* the FR-GDE.6 auto-heal problem attacked from the other end. Strong strategic fit with our thesis. | **P1 — highest-leverage item in this table** |
| G7 | **Scrolling capture is P1 in our PRD; it is a top-level, hotkeyed preset in Competitor A** | CAP-03 (U + V + O, three sources) | FR-CAP.6 is correctly specified but under-prioritised relative to how central it is to the competitor. A user evaluating a "Competitor A replacement" will try scrolling capture in the first five minutes. | **Raise FR-CAP.6 to P0** |
| G8 | **MP4 output** | REC-02 | Already a known gap (README "Known gaps"), and FR-REC.4 is already P0. Restated here only because Competitor A ships it and WebM-only is an immediate evaluation failure. | **P0, already specified** |
| G9 | **Localization (6 locales, including localized tutorial video)** | LOC-01, LOC-02 | PRD-002 has no i18n requirement at all. FR-GDE.7 localizes *guide output* at P2 but nothing localizes the *product*. A one-line NFR now is far cheaper than retrofitting. | **P2, but specify now** |
| G10 | **OS integration surface**: shell context menu, file association, thumbnail provider, Windows Search property handler, toast notifications, auto-update, crash reporting | AUT-05, AUT-07, AUT-09, AUT-11, AUT-14, OCR-09, OCR-10 | None of these are in either PRD. Individually small; collectively they are the difference between "an app" and "installed software." **Auto-update and crash reporting in particular are unspecified and will be discovered late.** | **P1 (update/crash), P2 (shell)** |
| G10a | **Interval/time-lapse capture with identical-frame discard, and scheduled capture** | CAP-18, CAP-19 | Neither PRD mentions either. Interval-with-dedupe is genuinely interesting for us specifically: it is a pixel-only approximation of "capture whenever something changed," which our state layer could do far more precisely. Low cost, and it pairs with FR-CLI.1 headless CI capture. | **P2** |
| G10b | **Output auto-naming and "send to program"** | SHR-13, SHR-14 | `SNAG-0001.png` with a configurable prefix/digits/overwrite policy is a small feature that shows up in every power-user workflow, and FR-CLI.1's "deterministic output paths" implies but never specifies it. | **P2** |
| G11 | **Content-aware fill / inpainting** for erasing objects | ANN-28 (V) | FR-ANN.3 gives us blur/pixelate/solid. Competitor A can make a thing *not have been there*. For redaction that must not look redacted, this is a real capability difference. | **P2** |
| G12 | **Screen Draw during recording**, and **picture-in-picture webcam** | REC-06, REC-04, REC-12 (`ScreenDrawStartsOn`/`ScreenDrawFadeDelay`, `PipShape`, `SelectedWebcamPlacement` are all preset-level fields, §2.8a) | FR-REC.1 lists webcam as a track but nothing says it composites as an overlay, and nothing covers annotating live. Both are visible, demoed features. | **P1** |
| G13 | **AI audio noise removal** | REC-05 (DeepFilterNet3 model, 11.8 MB) + `EnableBackgroundNoiseRemoval` as a preset field (§2.8a) | FR-AI.7 covers filler-word and dead-air removal but not denoising. Ships on-device in Competitor A, which also demonstrates FR-AI.9's on-device option is practical. | **P1** |
| G14 | **Rich raster format matrix and PDF export for images** | SHR-08, SHR-10 | We ship PNG/JPEG (`index.ts:385`). PDF is specified only for *guides* (FR-GDE.3). "Export this screenshot as PDF/TIFF" is a documentation-workflow staple. | **P2** (PDF), format matrix **P2** |
| G15 | **Cursor include/exclude on a still capture** | CAP-05 (U toggle) + `Presets8.xml` `<CaptureCursor>` (O) | Delay itself *is* covered (FR-CAP.7 P1). The gap is narrower and needs stating precisely: **PRD-001 FR-ANN.7 covers cursor *style* as part of a brand kit, but neither PRD covers cursor *inclusion* on a still capture** — a visible toggle on Competitor A's main window and a near-universal expectation. | **P1** |
| G16 | **A portable single-file project format** — `.snagx` is one ZIP holding image + vector objects + pages + metadata, is the Editor's titled document (ED-16), is OS-associated (AUT-05), and gets Explorer thumbnails (OCR-10) and Search properties (OCR-09) | ED-16, §2.10, AUT-05 | **The strongest structural gap in this section.** Our storage is a library index plus a DC-4 sidecar directory (`src/main/library.ts`, `src/main/sidecar/paths.ts`) — both machine-facing and neither portable. There is no answer to *"send me your editable capture."* It also affects `product-analyst` directly: DC-6 specifies sidecar revisioning but no export/import envelope. | **P1** |
| G17 | **Per-tool Quick Styles gallery, bound to a theme** | ED-09, EFX-04 | Distinct from G4 and narrower: G4 is "should a brand kit change authoring defaults at all," G17 is the *mechanism* — a visible gallery of named, themed presets **per tool**. `EditorView.tsx` offers a flat colour + stroke-width palette with no named style concept. This is the highest-frequency interaction in the whole Competitor A editor. | **P1** |
| G18 | **Annotation property depth: shadow (with direction), Bezier curves, independent start/end arrowhead sizes, per-object opacity and dash** | ED-10; `Favorites.json` (O) | **PRD-002 §2's IA already specifies an "Inspector — properties of the selected annotation", so the *panel* is covered — the gap is its *contents*.** Neither PRD names a single annotation property. Note the drift this exposes: `docs/ARCHITECTURE.md` §5 specified `StrokeStyle{opacity, dash}`, `headSize`, and `curve?: Point`; the shipped `src/shared/types.ts` `BaseShape` carries only `color` and `strokeWidth`. **Shadow appears in neither.** | **P1 for shadow + opacity** (cheap, high visual payoff); **P2 for Bezier and split arrowhead sizes** |
| G19 | **Select all objects of the active tool type** | ED-11 | A one-line editing affordance with no PRD mention and no equivalent in `EditorView.tsx`. Cheap; matters once a document has 20+ objects. | **P2** |
| G20 | **Persistent recent-captures tray inside the Editor**, mixing images and video | ED-13 | **Partially covered, and the difference is the point:** PRD-002 §2's IA puts "recent 5" in the **OS menu bar / tray**. Competitor A's is an *in-editor filmstrip*, always visible, that makes moving between recent captures a zero-navigation action — which is a different job from a tray shortcut, and directly serves `UX-IA.1`'s depth limit. Worth an explicit decision rather than assuming the IA line covers it. | **P2** |
| G21 | **The Editor is a five-mode workspace** (Editor / Library / Assets / Capture / Create), with **Capture reachable from inside it** | ED-02, ED-03, ED-05 | `UX-IA.2` guarantees Editor-from-capture; **nothing specifies capture-from-editor**, and our IA has no `Create` peer mode (that is G2) and no `Assets` concept (that is G5, plus an online asset library we have no analogue for). Recorded so the IA asymmetry is a decision, not an oversight. | **P2** |
| G22 | **Mode-dependent menus** — `Image` and `Video` are separate top-level menus | ED-01 | Evidence that Competitor A treats image editing and video editing as two distinct surfaces sharing a shell. Our PRDs assume one Editor with one tool rail (`FR-ANN.1-6` mixes still and video operations freely). Not a feature gap — an **information-architecture question** for `ux-designer` that our documents never pose. | **P2 — decide, don't necessarily copy** |

### 4.2 Legacy surface — deliberately do not copy

Listed so the omission is a decision on record rather than an oversight.

| # | Competitor A surface | Evidence | Why not |
|---|---|---|---|
| L1 | **Virtual printer capture** ("print to Competitor A") | CAP-09 — and it is **live**, not residue (`Get-Printer` returns it) | Solves "capture from an app that won't let you screenshot it," which mattered in 2003. Costs a signed kernel-adjacent print driver, an installer elevation path, and a permanent OS device. Enormous surface for a shrinking need. **Do not build.** Worth knowing it exists, because it explains `XP64/`, `Competitor API64.exe`, `Competitor APt64.dll` and `COMPETITOR-A.Printer*Options`. |
| L2 | TWAIN scanner/camera input | CAP-10 (candidate) | Not a screen-capture job. |
| L3 | FTP output | SHR-05 | Superseded by share links (FR-SHR.1). |
| L4 | Twitter/X and Evernote destinations | SHR-03 (`Tweetinvi.*`, `Evernote.dll`, `Thrift.dll`) | Almost certainly retired-but-still-linked in Competitor A itself (**unverified — §1.4.2**). Either way, not worth building. |
| L5 | Office-application COM outputs (Word/Excel/PowerPoint/OneNote) | SHR-03 | Deep COM interop with desktop Office for marginal benefit over clipboard. Our FR-INT list is better targeted. |
| L6 | Native COM automation API | AUT-03 | The *idea* (a programmatic API) is right and we already do it better via MCP (FR-AGT.1, all 12 tools implemented). Do not additionally ship COM. **But note §5.1 — Competitor A got to a programmatic API first, and 50 coclasses is a wider capture-configuration surface than our 12 MCP tools currently expose.** |
| L7 | Handwriting recognition | OCR-04 (candidate) | ABBYY comes with it; it isn't a screen-capture need. |
| L8 | 2,301 bundled stamp assets | ANN-20 | See G5 — the *capability* matters, the asset volume does not. |

### 4.3 Cross-check findings (per `capability-extraction` §cross-checking)

- **Requirement with no implementation:** FR-CAP.6 (scrolling), FR-REC.2/3/4-MP4,
  FR-REC.5-8, FR-AI.1/2/3-full, FR-SHR.*, FR-CLI.*, FR-GDE.* have no implementation trace
  in `src/`. Expected — these are later milestones — but recorded so the matrix's
  "Nawi: no" column isn't mistaken for a defect list.
- **Spec/implementation drift inside our own repo, surfaced by comparing against Competitor A's
  property panel (ED-10).** `docs/ARCHITECTURE.md` §5 (`:365-371`) specifies
  `StrokeStyle{color, width, opacity, dash}`, arrow `head`/`headSize`, `curve?: Point`,
  and `ShapeBase.rotation`. The shipped `src/shared/types.ts` `BaseShape` (`:149-158`)
  carries **only `color` and `strokeWidth`**; `SimpleShape` (`:174`) has no `curve`,
  no `headSize`, no `opacity`, no `dash`, no `rotation`. **This is reported as a
  documented-design vs. as-built divergence for `solution-architect` and
  `product-analyst`, not as a defect** — per `qa-engineer`'s Oracle Hierarchy the
  written architecture doc outranks current implementation behaviour, so the resolution
  is theirs to make.
- **`'line'` is in the shipped shape model but has no tool.** `ShapeKind` includes
  `'line'` (`src/shared/types.ts:132`) and `SimpleShape` accepts it (`:174`), but the
  tool rail defines eight tools and none is line (`EditorView.tsx:10-19`). A `'line'`
  shape can therefore exist in an `AnnotationDoc` and render, but no UI creates one.
  **Flagged as a possible gap-or-defect hypothesis for `qa-engineer` to triage, not
  asserted as either.**
- **`LibraryItem.tags?` is written by nothing.** The field exists
  (`src/shared/types.ts:121`) and `search_captures` reads it
  (`src/main/mcp/tools.ts:435`, which advertises search over "names and tags"), but no
  code path sets it. Competitor A exposes tagging as a bottom-bar button in the Editor
  (ED-12). Finding for `product-analyst`: FR-SHR.5 and FR-AI.4 both assume tags exist;
  today the search feature advertises a facet that is always empty.
- **Implementation with no requirement:** none found. Every `src/shared/ipc.ts` channel maps
  to an FR or UX id, and `src/shared/ipc.ts:34-37` is explicitly commented `UX-AGT.3`.
- **PRD-002 `UX-ANN.1` specifies `P` for pixelate and `S` for spotlight**; `EditorView.tsx:10-19`
  binds neither, and folds pixelate into `B` (`:17` label "Blur / pixelate",
  `:280` `mode: 'pixelate'`). **This is a spec/implementation divergence, reported as a
  finding for `product-analyst` and `qa-engineer` — not resolved here.**
- **No `persona-discovery` roster exists** in this repo (`.claude/discovery/` absent), so
  §3.6 persona-capability mapping was not performed. `Surveys/JtbdSurvey.json` (AUT-16) is
  offered as **candidate persona input** for that agent, not as a roster.

---

## 5. Where our PRD deliberately goes beyond Competitor A

This matrix is not a "we're behind" scorecard. Competitor A is a 20-year-old pixel tool with an
excellent breadth of manual authoring features. PRD-001's thesis is orthogonal.

### 5.1 The state layer — with one honest caveat

**Competitor A ships no DOM snapshot, no accessibility tree, no console log, no HAR, no input
event stream, and no monotonic timeline.** Nothing in the install tree suggests otherwise.
Nawi implements all six today (§3.7).

**The caveat, so this claim stays honest:** Competitor A is *not* a pure pixel tool.
`.snagx/metadata.json` persists `WebURL`, `WindowName`, `AppName`, `AppVersion`,
`OperatingSystemVersion`, `LanguageCode`, and `OcrText` (§2.10), and exposes them to
Windows Search (OCR-09). And `Interop.UIAutomationClient.dll` ships (CAP-15) — meaning a
UIA-based element-awareness capability adjacent to FR-CAP.5 **may** exist and was not
determinable statically. The differentiation is real but should be stated as *depth,
timeline alignment, and machine-consumability*, not as "they have nothing."

### 5.2 MCP as the primary programmatic interface

All 12 FR-AGT.1 tools are implemented (`src/main/mcp/tools.ts`), with token-bounded field
projection (`src/main/mcp/projection.ts`, FR-AGT.2) and revisioned sidecars
(`src/main/mcp/revision.ts`, DC-6). Competitor A's equivalent is a Windows-only COM API
(AUT-03) designed for VBScript-era desktop scripting. **Competitor A reached the "scriptable"
idea first and with a wider capture-configuration surface** — but no agent will ever
discover, negotiate, or token-budget a COM type library.

### 5.3 Record-to-test

FR-AGT.5 — emitting a runnable Playwright script from a recording, using ranked selectors
with stability scores (`src/main/cdp/selectors.ts`, `src/main/cdp/probe.ts:88`). Competitor A
has no analogue and no component that could support one.

### 5.4 Auto-heal

FR-GDE.6. Competitor A has no guide-versioning or step-health concept in its data model —
`.snagx` has no `health`, no `target_selectors`, no `last_verified_at`. **Note the
convergence, though:** Simplify (G6) attacks the same staleness problem by making the
screenshot abstract enough that a restyle doesn't invalidate it. Different answer to the
same question, and worth studying rather than dismissing.

### 5.5 Agent observability and the kill switch

FR-AGT.6 and UX-AGT.3 (implemented: `src/shared/ipc.ts:34-37`,
`AgentAccessToggle.tsx`) presuppose a world where a non-human operates the tool. Nothing in
Competitor A's design contemplates that.

### 5.6 Security posture as a product feature

FR-SEC.1 local-only mode, FR-SEC.2 secret-field suppression (implemented:
`src/main/cdp/probe.ts:128`, `src/main/harvest/snapshot.ts:130`,
`src/main/harvest/har.ts:25`), DC-3 transactional redaction. Competitor A's Smart Redact
(ANN-29) is pixel-side only — there is no state layer for a secret to leak into, which is
both why it's simpler and why it can't offer the same guarantee.

---

## 6. Handoff

**`product-manager`** — §4.1 is the decision list. G1 (presets), G6 (Simplify), and G7
(raise scrolling to P0) are the three where the evidence is strongest and the strategic fit
with our own thesis is real rather than parity-chasing. §4.2 is the explicit
don't-build list; L1 (virtual printer) is the one someone will otherwise propose.
**Open question for you:** G4 — PRD-002 `UX-VIS.5` currently forbids brand kits from
affecting the app; Competitor A's model is the opposite. That is a product stance, not a fact.

**`product-analyst`** — §3 gives you a cited baseline for new requirements. Two concrete
items: (a) the `UX-ANN.1` keybinding divergence in §4.3 needs resolving as a requirement
question, not a bug fix; (b) `.snagx`'s `metadata.json` field list (§2.10) is a
ready-made minimum for what a capture must record even when no state layer is available —
useful for tightening DC-2's `unsupported_surface` path.
**Open question for you:** does "capture" in FR-CAP mean *one image* or *a document*? G2
(multi-page/sections) has no home in the current requirement set because the PRD assumes
one capture = one asset.

**`solution-architect`** — §2.11. The load-bearing observations: the ML/OCR stack is
~250 MB of the install and is the dominant packaging cost of an OCR feature (FR-AI.2 P0);
`.snagx` is a plain ZIP of JSON + PNG, which is a proven and unglamorous format choice for
a non-destructive editor and worth comparing against our sidecar layout
(`src/main/sidecar/`); and Competitor A runs three DI containers in one process, which is what
20 years of accretion looks like.
**Open question for you:** Competitor A ships UIA interop (CAP-15) but its use is unverified.
FR-STA.8 (desktop-native structured capture via UIAutomation) is P2 in our PRD — whether
that's a competitive gap depends on an answer we could not obtain.

**`ux-designer`** — the interaction patterns worth studying, with evidence: the capture
window's **preset rail** (U — hotkey-per-preset in a persistent list); **enhanced tooltips**
as HTML + autoplaying demo video + "Learn More" deep link (A11Y-02) rather than a text
tooltip; and the **stitching progress copy** (`Messages/Stitching.json` — 20 rotating
messages, "Enjoy this dog while you wait…") as a deliberate answer to an unavoidably slow
operation, which is directly relevant to `UX-STA.2` progressive disclosure.
**Open question for you:** is the Competitor A tool count (22, §2.4) a model to approach or to
avoid? `EnhancedTooltips/more-tool/` "More Menu" is evidence they outgrew their own toolbar.

---

## 7. Evidence appendix

All paths relative to `the install directory` unless noted.

| Ref | Source | Established |
|---|---|---|
| E1 | `a package manifest` | version and packaging metadata |
| E2 | PE `VersionInfo` on 7 EXEs + ~35 first-party DLLs (PowerShell `Get-ChildItem \| VersionInfo`) | §2.1 executable roles; `a vendor module` = "Scrolling capture support"; `a vendor module` = "in-painting module"; `a vendor artifact` = "Competitor A Printer Driver" |
| E3 | `HKLM\SOFTWARE\Classes` filtered on `^(COMPETITOR-A\|Competitor A\|the vendor\|tsc)` | ~50 COM ProgIDs (AUT-03), `a vendor artifact`, `a vendor artifact`, `Competitor A.MainShellExt` |
| E4 | `HKLM\SOFTWARE\Classes`: `Competitor A.26.Picture`, `the vendorcompetitor-a`, and the two `com.the vendor.competitor-a{capture,editor}` keys (the latter enumerated by filtering all of `HKLM\SOFTWARE\Classes` for a `URL Protocol` value) | AUT-05 file association; AUT-06 — exactly two registered URL protocols, both the vendor-namespaced |
| E5 | `Get-Printer` | Live printer `Competitor A`, driver `Competitor A Printer Driver` (CAP-09) |
| E6 | `EnhancedTooltips/*/ENU/index.html` (22 dirs) | 22 tool names + vendor descriptions + `tscredirect://` link scheme (§2.4) |
| E7 | `Favorites.json` | QuickStyle ~55-key schema: `ToolMode`, `BlurType`, `MagnifyScale`, `Tolerance`, `CreateAsVector`, `StepSequenceType`, `CutOutStyle`, `SimplifyShape` |
| E8 | `Themes/Basic.snagtheme` | Theme schema: `QuickStyles[]`, `ThemeColors`, `FontFamily`, `FontEmphasis`, `DropShadow`, `ExportedFromPlatform` |
| E9 | `Palettes/*.snagpalette` | Palette as a separate shareable JSON object |
| E10 | `en-US/EditorOverview.snagx`, `en-US/TemplateOnboarding.snagx` (ZIP) | §2.10 data model; `metadata.json` field list; 29 `CaptureObjects` incl. `RTFEncodedText` |
| E11 | `3rdparty_licenses.txt` §§1-22 | Vendor-declared: Chromium, GifLib, FreeType, libpng, libyuv, **ABBYY FineReader (§14)**, Google Fonts, zlib, WebView2, OpenSSL, Websocket++, Boost, Intel |
| E12 | `Messages/Stitching.json` | 20 rotating scrolling-capture progress messages, localized |
| E13 | `Surveys/JtbdSurvey.json` | the vendor's own JTBD answer set (AUT-16) |
| E14 | `en-US/*.mp4` (16 tutorial videos) | Vendor-authored feature demos: `smart-redact`, `remove-background-noise`, `screen-draw`, `picture-in-picture`, `multi-track`, `record-screen-webcam`, `step-capture`, `scrolling-{small,medium,large}`, `share-link`, `edit-images-from-Competitor B-editor`, `send-images-to-Competitor B-online`, `crop-your-image`, `add-steps-to-your-capture`, `point-out-important-information` |
| E15 | UTF-16 string scan of `a vendor artifact` | CLI switches (AUT-04) |
| E16 | Directory listing: `Stamps/` 9 categories, 2,301 files; `Simplify/` 7; `Step/` 4; `Templates/` 13; `dictionaries/` 6 languages; 6 locale dirs | ANN-19, ANN-20, ANN-21, EFX-06, ANN-31, LOC-01 |
| E16a | `%LOCALAPPDATA%\the vendor\Competitor A\Presets8.xml` (44.7 KB `Presets7.xml` also present), plus sibling `Tools2.xml`, `ImageQuickStylesV2.xml`, `GifExportOptions.xml`, `ProgramOutputs.xml`, `AppSettings.json` | §2.8a preset schema; CAP-18, CAP-19, CAP-20, REC-11, REC-12, REC-13, SHR-13, SHR-14, SHR-15, ANN-37, AUT-01a; promotion of AUT-08 |
| E16b | `EnhancedTooltips/*/ENU/index.html` `<div class="tpot-text">` extracted for all 22 tools | The verbatim vendor descriptions in §2.4 |
| E17 | `en-US/Competitor AHelpOffline.pdf`, text-extracted | **Contains no feature documentation** — offline-resources leaflet only (§1.2) |
| E17a | **Second user-supplied screenshot: Competitor A Editor**, title bar `2026-08-28_15-09-21.snagx - Competitor A Editor` | All of §2.12 (ED-01…ED-16); gaps G16–G22; the EFX-04 and ANN-07/ANN-13 confirmations |
| E18 | User-supplied screenshot of the Competitor A capture window | Tier U throughout: modes, toggles, Selection/Effects/Share dropdowns, 6 presets and their hotkeys, "Open in Competitor B Editor (New!)" |
| E19 | Nawi `src/shared/ipc.ts`, `src/main/mcp/tools.ts`, `src/renderer/components/EditorView.tsx`, `src/main/capture.ts`, `src/main/index.ts`, `src/shared/settings.ts`, `src/main/harvest/*`, `src/main/cdp/*`, `src/main/sidecar/*` | Column 3 of §3 throughout |
| E20 | Nawi `docs/PRD-001-core-capture-platform.md`, `docs/PRD-002-user-experience.md` | Column 2 of §3 throughout; PRD-002 §2 IA (`:43-90`) for the Inspector and "recent 5" reconciliations in G18/G20 |
| E21 | Nawi `docs/ARCHITECTURE.md:360-380` (shape model) vs. `src/shared/types.ts:125-190` | The spec/as-built annotation-property drift in §4.3 and G18 |
