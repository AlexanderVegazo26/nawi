import { describe, evidenceLines, missReason, scoreText, type RecordedStep, type RunRecord } from './run-record'

/**
 * Roadmap F4c: the run's self-contained HTML report (`runs/<run-id>/report.html`).
 *
 * One file a person can open from a CI artifact, an e-mail or a chat: no
 * script, no network, no other file. Screenshots are embedded as data URIs, so
 * the report still works when it is moved away from its run folder. The page
 * carries a Content-Security-Policy that forbids everything except inline
 * styles and data images, so even text the page under test produced (console
 * messages, URLs) cannot run anything here; all of that text is HTML-escaped
 * as well.
 *
 * Pure: the screenshot bytes come from the same map the run record writes, and
 * the text from the run record, which has been scrubbed of secret values.
 */

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg' }

export function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const STATUS_LABEL: Record<string, string> = {
  passed: 'Passed',
  failed: 'Failed',
  skipped: 'Skipped',
  not_run: 'Not run'
}

const ms = (value: number | undefined): string => {
  if (value === undefined) return ''
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`
}

const CSS = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1b1f24;--muted:#57606a;--line:#d0d7de;--ok:#1a7f37;--bad:#cf222e;--warn:#9a6700;--card:#f6f8fa}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--line:#30363d;--ok:#3fb950;--bad:#f85149;--warn:#d29922;--card:#161b22}}
*{box-sizing:border-box}
body{margin:0;padding:1rem;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;overflow-wrap:anywhere}
main{max-width:64rem;margin:0 auto}
h1{font-size:1.5rem;margin:0 0 .25rem}
h2{font-size:1.1rem;margin:1.5rem 0 .5rem}
.muted{color:var(--muted)}
.intent{color:var(--fg);font-style:italic}
.drift{color:var(--warn);font-weight:600}
.badge{display:inline-block;padding:0 .5rem;border:1px solid currentColor;border-radius:1rem;font-size:.85rem;font-weight:600}
.passed{color:var(--ok)}.failed{color:var(--bad)}.skipped,.not_run{color:var(--muted)}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.15rem 1rem;margin:.5rem 0}
dt{color:var(--muted)}dd{margin:0}
ol.steps{list-style:none;margin:0;padding:0}
ol.steps>li{border:1px solid var(--line);border-left:.35rem solid currentColor;border-radius:.4rem;margin:.6rem 0;padding:.5rem .75rem;background:var(--card)}
.head{display:flex;flex-wrap:wrap;gap:.25rem .75rem;align-items:baseline}
.head strong{color:var(--fg)}
pre{margin:.25rem 0;padding:.5rem;background:var(--bg);border:1px solid var(--line);border-radius:.3rem;white-space:pre-wrap;color:var(--fg)}
.shots{display:flex;flex-wrap:wrap;gap:.75rem;margin:.5rem 0}
figure{margin:0;flex:1 1 14rem;max-width:100%}
figcaption{font-size:.85rem;color:var(--muted)}
img{max-width:100%;height:auto;border:1px solid var(--line);border-radius:.3rem;display:block}
details{margin:.35rem 0}
summary{cursor:pointer}
ul{margin:.25rem 0;padding-left:1.25rem}
`

export function toHtmlReport(record: RunRecord, assets: ReadonlyMap<string, Buffer>): string {
  const image = (path: string | undefined, caption: string): string => {
    if (path === undefined) return ''
    const bytes = assets.get(path)
    const mime = MIME[path.slice(path.lastIndexOf('.') + 1)]
    if (!bytes || !mime) return `<figure><figcaption>${htmlEscape(caption)}: file not available</figcaption></figure>`
    // The alt text is the caption, so the image still means something to a screen reader.
    return `<figure><img alt="${htmlEscape(caption)}" src="data:${mime};base64,${bytes.toString('base64')}"><figcaption>${htmlEscape(caption)}</figcaption></figure>`
  }

  const evidence = (e: Parameters<typeof evidenceLines>[0]): string => {
    const lines = evidenceLines(e)
    if (lines.length === 0) return ''
    return `<details><summary>Page evidence (${lines.length})</summary><ul>${lines.map((l) => `<li>${htmlEscape(l)}</li>`).join('')}</ul></details>`
  }

  const step = (s: RecordedStep, index: number): string => {
    // A step's "before" is usually the previous step's "after" (one file): show it only where it is new,
    // so the report holds each image once.
    const before = s.shots?.before !== undefined && s.shots.before === record.steps[index - 1]?.shots?.after ? undefined : s.shots?.before
    const detail: string[] = []
    if (s.error) detail.push(`<pre>${htmlEscape(s.error)}</pre>`)
    if (s.intent !== undefined) detail.push(`<div class="intent">${htmlEscape(s.intent)}</div>`)
    if (s.matched) {
      const layer = typeof s.matched.layer === 'string' ? ` by ${htmlEscape(s.matched.layer)}` : ''
      const drift = s.matched.fallback && s.status === 'passed'
        ? ' <span class="drift">fallback: a more stable locator found nothing, update the flow</span>'
        : ''
      detail.push(`<div class="muted">Matched locator ${s.matched.index}${layer}: ${htmlEscape(describe(s.matched.selector as Record<string, unknown>) + scoreText(s.matched.score))}${drift}</div>`)
    }
    for (const miss of s.misses ?? []) {
      const why = missReason(miss)
      detail.push(`<div class="muted">Locator ${miss.index} ${htmlEscape(describe(miss.selector as Record<string, unknown>))}: ${htmlEscape(why)}</div>`)
    }
    if (s.url !== undefined) detail.push(`<div class="muted">Page after the step: ${htmlEscape(s.url)}</div>`)
    for (const d of s.dialogs ?? []) detail.push(`<div class="muted">Dialog (${htmlEscape(d.type)}): ${htmlEscape(d.message)}</div>`)
    const shots = [
      image(before, 'Before the step'),
      image(s.shots?.after, 'After the step'),
      image(s.screenshot, 'Screenshot taken by the step')
    ].join('')
    return (
      `<li id="step-${index + 1}" class="${htmlEscape(s.status)}">` +
      `<div class="head"><strong>${index + 1}. ${htmlEscape(s.id)}</strong>` +
      `<span class="muted">${htmlEscape(s.action)}</span>` +
      `<span class="badge">${htmlEscape(STATUS_LABEL[s.status] ?? s.status)}</span>` +
      `<span class="muted">${htmlEscape(ms(s.duration_ms))}</span></div>` +
      detail.join('') +
      evidence(s) +
      (shots ? `<div class="shots">${shots}</div>` : '') +
      '</li>'
    )
  }

  const t = record.totals
  const failedIndex = record.failed_step_id === undefined ? -1 : record.steps.findIndex((s) => s.id === record.failed_step_id)
  const env = record.environment
  const rows: Array<[string, string]> = [
    ['Flow file', record.flow.file],
    [typeof record.heal_of === 'string' ? 'Proposed flow SHA-256' : 'Flow SHA-256', record.flow.sha256],
    ['Started', record.started_at],
    ['Duration', ms(record.duration_ms)],
    ['Run id', record.run_id],
    ['System', `${env.os.platform} ${env.os.release} (${env.os.arch})`]
  ]
  if (env.app_version) rows.push(['Nawi', env.app_version])
  if (env.browser) rows.push(['Browser', env.browser.product])
  if (env.device) {
    rows.push(['Device', `${env.device.name}${env.device.kind === 'avd' ? ' (virtual device)' : ''}${env.device.api !== null ? `, Android API ${env.device.api}` : ''}`])
    rows.push(['App', env.device.launched_activity ? `${env.device.package} (started ${env.device.launched_activity})` : env.device.package])
  }
  if (env.viewport) rows.push(['Viewport', `${env.viewport.width}x${env.viewport.height} at ${env.viewport.device_scale_factor}x`])
  if (record.final_url) rows.push(['Final page', record.final_url])

  const summary = `${t.passed} passed, ${t.failed} failed, ${t.skipped} skipped, ${t.not_run} not run`
  const fallbackIds = Array.isArray(record.fallback_step_ids) ? record.fallback_step_ids : []
  const drift =
    fallbackIds.length > 0
      ? `<p class="drift">${fallbackIds.length} step${fallbackIds.length === 1 ? '' : 's'} found ${fallbackIds.length === 1 ? 'its' : 'their'} target only by a fallback locator: ${fallbackIds
          .map((id) => {
            const i = record.steps.findIndex((s) => s.id === id)
            return i >= 0 ? `<a href="#step-${i + 1}">${htmlEscape(id)}</a>` : htmlEscape(id)
          })
          .join(', ')}. The flow is drifting from the app; update those locators before they fail.</p>`
      : ''
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    // No script, no network, no frames: only the inline style and the embedded images.
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${htmlEscape(`${record.flow.name}: ${STATUS_LABEL[record.status] ?? record.status}`)}</title>`,
    `<style>${CSS}</style></head><body><main>`,
    `<h1>${htmlEscape(record.flow.name)} <span class="badge ${htmlEscape(record.status)}">${htmlEscape(STATUS_LABEL[record.status] ?? record.status)}</span></h1>`,
    `<p class="muted">${htmlEscape(summary)}${failedIndex >= 0 ? ` · first failure: <a href="#step-${failedIndex + 1}">${htmlEscape(record.steps[failedIndex].id)}</a>` : ''}</p>`,
    record.error ? `<pre>${htmlEscape(record.error)}</pre>` : '',
    typeof record.heal_of === 'string'
      ? `<p class="muted">Replay of the healing proposals of run ${htmlEscape(record.heal_of)}: it ran the proposed flow, not the file as it was. The file holds that flow only if the heal was applied.</p>`
      : '',
    drift,
    `<dl>${rows.map(([k, v]) => `<dt>${htmlEscape(k)}</dt><dd>${htmlEscape(v)}</dd>`).join('')}</dl>`,
    record.opening ? `<h2>While opening the target</h2>${evidence(record.opening)}` : '',
    `<h2>Steps (${record.steps.length})</h2>`,
    record.steps.length === 0 ? '<p class="muted">No step ran.</p>' : `<ol class="steps">${record.steps.map(step).join('')}</ol>`,
    '</main></body></html>',
    ''
  ].join('\n')
}
