#!/usr/bin/env node
/**
 * Builds the profile images in assets/ from data/profile.json.
 *
 *   node scripts/build-assets.mjs
 *
 * - Every image is written twice: *-dark.svg and *-light.svg (the README picks one per GitHub theme).
 * - Every image has a phone layout, switched on by a CSS media query when it is displayed narrow.
 * - Dynamic values (years of experience, LeetCode numbers) are computed at build time; the
 *   "Profile assets" workflow re-runs this weekly. LeetCode numbers are cached in data/leetcode.json
 *   so a failed fetch never wipes them.
 * - Output is deterministic: same data and same month give byte-identical files (no empty commits).
 *
 * No dependencies; needs Node 18+ (global fetch). Set PROFILE_NOW=YYYY-MM-DD to test another date.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const file = path => new URL(path, root)

// ── Themes ─────────────────────────────────────────────────────────

const THEMES = {
  dark: {
    bg: '#0d1117', panel: '#161b22', panelBar: '#1c2128', line: '#30363d', track: '#21262d', dots: '#21262d',
    text: '#e6edf3', soft: '#c9d1d9', muted: '#8b949e',
    blue: '#58a6ff', purple: '#d2a8ff', violet: '#a371f7', pink: '#f778ba', green: '#3fb950',
    glowA: '#1f6feb', glowB: '#8957e5', glow: [0.35, 0.7],
    easy: '#00b8a3', medium: '#ffc01e', hard: '#ef4743',
  },
  light: {
    bg: '#ffffff', panel: '#f6f8fa', panelBar: '#eaeef2', line: '#d0d7de', track: '#eaeef2', dots: '#d8dee4',
    text: '#1f2328', soft: '#24292f', muted: '#59636e',
    blue: '#0969da', purple: '#8250df', violet: '#8250df', pink: '#bf3989', green: '#1a7f37',
    glowA: '#54aeff', glowB: '#c297ff', glow: [0.18, 0.35],
    easy: '#00a38c', medium: '#d4a017', hard: '#d1242f',
  },
}

const FONTS = `
    .sans { font-family: 'Segoe UI', Ubuntu, 'Helvetica Neue', Arial, sans-serif; }
    .mono { font-family: Consolas, 'SFMono-Regular', Menlo, 'Courier New', monospace; }`

/** Phone layout: `.wide` parts hide and `.narrow` parts show when the image is displayed narrow. */
const LAYOUT_SWITCH = `
    .narrow { display: none; }
    @media (max-width: 640px) { .wide { display: none; } .narrow { display: inline; } }`

// ── Helpers ────────────────────────────────────────────────────────

const esc = text =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Rough rendered width of a string, enough to size pills and clip boxes. */
const textWidth = (text, size, factor = 0.56) => Math.ceil([...text].length * size * factor)

const parseMonth = value => {
  const [year, month] = value.split('-').map(Number)
  return { year, month }
}

const monthsBetween = (from, to) => (to.year - from.year) * 12 + (to.month - from.month)

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function experienceLabel(start, now) {
  const months = Math.max(0, monthsBetween(start, now))
  const years = Math.floor(months / 12)
  return years >= 1 ? `${years}+ years` : `${months} months`
}

function periodLabel(item) {
  const start = parseMonth(item.start).year
  if (!item.end) return `${start} – now`
  const end = parseMonth(item.end).year
  return start === end ? String(start) : `${start} – ${end}`
}

// ── Header ─────────────────────────────────────────────────────────

function header(t, data, years) {
  const roleSize = 19
  const typeWidth = Math.max(...data.roles.map(role => textWidth(`> ${role}`, roleSize, 0.6))) + 24
  const roleCount = data.roles.length

  // Desktop: each role is "typed" by a clip box that grows, holds, then shrinks; chained in a loop.
  const clips = data.roles
    .map((_, i) => {
      const begin = i === 0 ? `0s;t${roleCount}.end` : `t${i}.end`
      return `<clipPath id="type${i + 1}"><rect x="48" y="168" height="32" width="0">
      <animate id="t${i + 1}" attributeName="width" values="0;${typeWidth};${typeWidth};0" keyTimes="0;0.35;0.85;1" dur="4s" begin="${begin}" calcMode="spline" keySplines=".4 0 .2 1;0 0 1 1;.4 0 .2 1"/>
    </rect></clipPath>`
    })
    .join('\n    ')

  const typedRoles = data.roles
    .map(
      (role, i) =>
        `<text x="48" y="190" clip-path="url(#type${i + 1})"><tspan fill="${t.green}">&gt; </tspan><tspan fill="${t.soft}">${esc(role)}</tspan></text>`,
    )
    .join('\n    ')

  // Phone: the roles cross-fade in the centre instead of being typed.
  const cycle = roleCount * 4
  const fadeKeyframes = data.roles
    .map((_, i) => {
      const a = (i * 100) / roleCount
      const b = ((i + 1) * 100) / roleCount
      return `@keyframes r${i} { 0% { opacity: 0 } ${a ? `${a}% { opacity: 0 } ` : ''}${(a + 3).toFixed(1)}% { opacity: 1 } ${(b - 3).toFixed(1)}% { opacity: 1 } ${b}% { opacity: 0 } 100% { opacity: 0 } }`
    })
    .join('\n    ')
  const fadeRoles = data.roles
    .map(
      (role, i) =>
        `<text class="mono" x="500" y="206" font-size="36" text-anchor="middle" style="opacity:0;animation:r${i} ${cycle}s infinite"><tspan fill="${t.green}">&gt; </tspan><tspan fill="${t.soft}">${esc(role)}</tspan></text>`,
    )
    .join('\n    ')

  // Terminal lines appear one by one, stay, then clear and replay.
  const lines = [
    `<tspan fill="${t.green}">~ $</tspan><tspan fill="${t.soft}"> whoami</tspan>`,
    `<tspan fill="${t.muted}">${esc(data.terminal.whoami)}</tspan>`,
    `<tspan fill="${t.green}">~ $</tspan><tspan fill="${t.soft}"> cat stack.txt</tspan>`,
    `<tspan fill="${t.muted}">${esc(data.terminal.stack)}</tspan>`,
    `<tspan fill="${t.green}">~ $</tspan><tspan fill="${t.soft}"> ./now.sh</tspan>`,
    // The terminal window fits two "now" lines; extra entries in the data file are ignored.
    ...data.terminal.now.slice(0, 2).map(
      (item, i) =>
        `<tspan fill="${i === 0 ? t.blue : t.purple}">●</tspan><tspan fill="${t.muted}"> ${esc(item.label)}: ${esc(item.text)}</tspan>`,
    ),
  ]
  const lineY = i => 56 + i * 23
  const appearAt = i => 2 + i * 7 // % of the 14 s loop
  const lineKeyframes = [...lines, 'cursor']
    .map((_, i) => `@keyframes l${i} { 0%, ${appearAt(i)}% { opacity: 0 } ${appearAt(i) + 2}%, 92% { opacity: 1 } 96%, 100% { opacity: 0 } }`)
    .join('\n    ')
  const terminalLines = lines
    .map((line, i) => `<text x="16" y="${lineY(i)}" style="opacity:0;animation:l${i} 14s infinite">${line}</text>`)
    .join('\n      ')
  const cursorIndex = lines.length
  const cursorY = lineY(cursorIndex)

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="300" viewBox="0 0 1000 300" role="img" aria-labelledby="title desc">
  <title id="title">${esc(data.name)}, Full-Stack Software Engineer</title>
  <desc id="desc">${esc(data.roles.join('. '))}. ${esc(data.location)}, ${years} of experience.</desc>
  <defs>
    <linearGradient id="border" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${t.blue}"/><stop offset="0.35" stop-color="${t.violet}"/>
      <stop offset="0.7" stop-color="${t.pink}"/><stop offset="1" stop-color="${t.blue}"/>
      <animateTransform attributeName="gradientTransform" type="rotate" from="0 .5 .5" to="360 .5 .5" dur="8s" repeatCount="indefinite"/>
    </linearGradient>
    <linearGradient id="name" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="520" y2="0" spreadMethod="reflect">
      <stop offset="0" stop-color="${t.blue}"/><stop offset="0.5" stop-color="${t.purple}"/><stop offset="1" stop-color="${t.blue}"/>
      <animate attributeName="x1" values="0;520;0" dur="6s" repeatCount="indefinite"/>
      <animate attributeName="x2" values="520;1040;520" dur="6s" repeatCount="indefinite"/>
    </linearGradient>
    <filter id="blur" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="40"/></filter>
    <pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1" fill="${t.dots}"/></pattern>
    <clipPath id="card"><rect x="2" y="2" width="996" height="296" rx="18"/></clipPath>
    ${clips}
  </defs>
  <style>${FONTS}${LAYOUT_SWITCH}
    ${lineKeyframes}
    ${fadeKeyframes}
    .cursor { animation: blink 1s steps(1) infinite; }
    @keyframes blink { 50% { opacity: 0 } }
    .float { opacity: 0; animation: float 9s ease-in-out infinite; }
    @keyframes float { 0% { opacity: 0; transform: translateY(20px) } 20%, 80% { opacity: .22 } 100% { opacity: 0; transform: translateY(-60px) } }
    .glow { animation: pulse 7s ease-in-out infinite alternate; }
    @keyframes pulse { from { opacity: ${t.glow[0]} } to { opacity: ${t.glow[1]} } }
    .live { animation: live 1.6s ease-out infinite; transform-origin: 66px 254px; }
    @keyframes live { 0% { transform: scale(1); opacity: .8 } 100% { transform: scale(2.6); opacity: 0 } }
  </style>

  <g clip-path="url(#card)">
    <rect width="1000" height="300" fill="${t.bg}"/>
    <rect width="1000" height="300" fill="url(#dots)"/>
    <circle class="glow" cx="170" cy="60" r="140" fill="${t.glowA}" filter="url(#blur)"/>
    <circle class="glow" cx="860" cy="270" r="150" fill="${t.glowB}" filter="url(#blur)" style="animation-delay:-3s"/>
    <g class="mono" font-size="20" fill="${t.blue}">
      <text class="float" x="430" y="80">{ }</text>
      <text class="float" x="520" y="250" style="animation-delay:-2s">&lt;/&gt;</text>
      <text class="float" x="300" y="270" style="animation-delay:-4s">=&gt;</text>
      <text class="float" x="960" y="60" style="animation-delay:-6s">@</text>
      <text class="float" x="470" y="150" style="animation-delay:-7.5s">;</text>
    </g>
  </g>
  <rect x="2" y="2" width="996" height="296" rx="18" fill="none" stroke="url(#border)" stroke-width="2.5"/>

  <g class="wide">
    <text class="mono" x="48" y="78" font-size="17" fill="${t.muted}">${esc(data.greeting)}</text>
    <text class="sans" x="46" y="138" font-size="50" font-weight="700" fill="url(#name)">${esc(data.name)}</text>
    <g class="mono" font-size="${roleSize}">
    ${typedRoles}
    </g>
    <circle class="live" cx="66" cy="254" r="5" fill="${t.green}"/>
    <circle cx="66" cy="254" r="5" fill="${t.green}"/>
    <text class="sans" x="80" y="259" font-size="15" fill="${t.muted}">${esc(data.location)}  ·  ${years} in production code</text>

    <g transform="translate(560 32)">
      <rect width="404" height="236" rx="10" fill="${t.panel}" stroke="${t.line}"/>
      <rect width="404" height="30" rx="10" fill="${t.panelBar}"/>
      <rect y="20" width="404" height="10" fill="${t.panelBar}"/>
      <circle cx="18" cy="15" r="5" fill="#ff5f56"/><circle cx="36" cy="15" r="5" fill="#ffbd2e"/><circle cx="54" cy="15" r="5" fill="#27c93f"/>
      <text class="mono" x="202" y="19" font-size="12" fill="${t.muted}" text-anchor="middle">abdellah@dev: ~</text>
      <g class="mono" font-size="14">
      ${terminalLines}
      <g style="opacity:0;animation:l${cursorIndex} 14s infinite">
        <text x="16" y="${cursorY}" fill="${t.green}">~ $</text>
        <rect class="cursor" x="50" y="${cursorY - 11}" width="8" height="15" fill="${t.soft}"/>
      </g>
      </g>
    </g>
  </g>

  <g class="narrow">
    <text class="sans" x="500" y="138" font-size="74" font-weight="700" fill="url(#name)" text-anchor="middle">${esc(data.name)}</text>
    ${fadeRoles}
    <text class="sans" x="500" y="264" font-size="28" fill="${t.muted}" text-anchor="middle"><tspan fill="${t.green}">● </tspan>${esc(data.location.split(',')[0])}  ·  ${years}</text>
  </g>
</svg>
`
}

// ── Experience timeline ────────────────────────────────────────────

function timeline(t, data) {
  const items = data.timeline
  const spacing = 880 / items.length
  const centerX = i => Math.round(60 + spacing * (i + 0.5))
  const lastX = centerX(items.length - 1)
  const nodeColors = [t.blue, '#79c0ff', t.violet, t.purple]

  const steps = items
    .map((item, i) => {
      const x = centerX(i)
      const current = !item.end
      const color = current ? t.purple : nodeColors[i % nodeColors.length]
      const node = current
        ? `<circle class="ring" cx="${x}" cy="120" r="8" fill="none" stroke="${t.purple}" stroke-width="2"/>
      <circle cx="${x}" cy="120" r="8" fill="${t.purple}"/>`
        : `<circle cx="${x}" cy="120" r="8" fill="${t.bg}" stroke="${color}" stroke-width="3"/>`
      const details = item.lines
        .map((line, j) => `<text class="sans wide" x="${x}" y="${182 + j * 22}" font-size="13" fill="${t.muted}" text-anchor="middle">${esc(line)}</text>`)
        .join('\n      ')
      const highlightY = 182 + item.lines.length * 22 + 2
      const highlight = item.highlight
        ? `<text class="sans wide" x="${x}" y="${highlightY}" font-size="14" font-weight="700" fill="${t.green}" text-anchor="middle">${esc(item.highlight)}</text>`
        : ''
      const shortHighlight = item.highlightShort
        ? `<text class="sans narrow" x="${x}" y="226" font-size="26" font-weight="700" fill="${t.green}" text-anchor="middle">${esc(item.highlightShort)}</text>`
        : ''

      return `<g class="step" style="animation-delay:${(0.5 + i * 0.5).toFixed(1)}s">
      <text class="mono date" x="${x}" y="94" fill="${current ? t.purple : t.muted}" text-anchor="middle">${esc(periodLabel(item))}</text>
      ${node}
      <text class="sans wide" x="${x}" y="158" font-size="16" font-weight="600" fill="${t.text}" text-anchor="middle">${esc(item.title)}</text>
      <text class="sans narrow" x="${x}" y="178" font-size="32" font-weight="600" fill="${t.text}" text-anchor="middle">${esc(item.short)}</text>
      ${details}
      ${highlight}
      ${shortHighlight}
    </g>`
    })
    .join('\n    ')

  const start = parseMonth(data.careerStart)

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="270" viewBox="0 0 1000 270" role="img" aria-labelledby="title desc">
  <title id="title">Experience at ${esc(data.company.name)}</title>
  <desc id="desc">${esc(items.map(item => `${item.title} (${periodLabel(item)})${item.highlight ? `, ${item.highlight.replace('⚡ ', '')}` : ''}`).join('; '))}.</desc>
  <defs>
    <linearGradient id="border" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${t.line}"/><stop offset="0.5" stop-color="${t.blue}" stop-opacity=".6"/><stop offset="1" stop-color="${t.line}"/>
      <animateTransform attributeName="gradientTransform" type="rotate" from="0 .5 .5" to="360 .5 .5" dur="10s" repeatCount="indefinite"/>
    </linearGradient>
    <linearGradient id="track" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${t.blue}"/><stop offset="1" stop-color="${t.purple}"/></linearGradient>
    <radialGradient id="comet"><stop offset="0" stop-color="#ffffff"/><stop offset=".4" stop-color="${t.blue}"/><stop offset="1" stop-color="${t.blue}" stop-opacity="0"/></radialGradient>
  </defs>
  <style>${FONTS}${LAYOUT_SWITCH}
    .date { font-size: 13px; }
    .heading { font-size: 19px; }
    @media (max-width: 640px) { .date { font-size: 26px; } .heading { font-size: 36px; } }
    .draw { stroke-dasharray: 880; stroke-dashoffset: 880; animation: draw 2.2s ease-out .2s forwards; }
    @keyframes draw { to { stroke-dashoffset: 0 } }
    .step { opacity: 0; animation: rise .7s ease-out forwards; }
    @keyframes rise { from { opacity: 0; transform: translateY(10px) } to { opacity: 1; transform: none } }
    .ring { animation: ring 1.8s ease-out infinite; transform-origin: ${lastX}px 120px; }
    @keyframes ring { 0% { transform: scale(1); opacity: .9 } 100% { transform: scale(3); opacity: 0 } }
  </style>

  <rect x="1.5" y="1.5" width="997" height="267" rx="16" fill="${t.bg}" stroke="url(#border)" stroke-width="2"/>
  <text class="sans heading" x="40" y="46" font-weight="700" fill="${t.text}">${esc(data.company.title)} · <tspan fill="${t.blue}">${esc(data.company.name)}</tspan></text>
  <text class="mono wide" x="960" y="44" font-size="14" fill="${t.muted}" text-anchor="end">${esc(data.company.city)} · ${MONTH_NAMES[start.month - 1]} ${start.year} → now</text>

  <line x1="60" y1="120" x2="940" y2="120" stroke="${t.track}" stroke-width="4" stroke-linecap="round"/>
  <line class="draw" x1="60" y1="120" x2="940" y2="120" stroke="url(#track)" stroke-width="4" stroke-linecap="round"/>
  <circle cy="120" r="9" fill="url(#comet)" opacity="0">
    <animate attributeName="cx" values="60;940" dur="5s" begin="2.5s" repeatCount="indefinite"/>
    <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;.1;.9;1" dur="5s" begin="2.5s" repeatCount="indefinite"/>
  </circle>

  ${steps}
</svg>
`
}

// ── Certifications marquee ─────────────────────────────────────────

function certifications(t, data) {
  const certs = data.certifications
  const half = Math.ceil(certs.length / 2)
  const rows = [certs.slice(0, half), certs.slice(half)]
  const fontSize = 15
  const gap = 14

  const pills = row => {
    let x = 0
    const shapes = row.map(cert => {
      const label = cert.issuer ? `${cert.title} · ${cert.issuer}` : cert.title
      const width = textWidth(label, fontSize, 0.54) + 44
      const shape = `<g transform="translate(${x} 0)">
        <rect width="${width}" height="40" rx="20" fill="${t.panel}" stroke="${t.line}"/>
        <circle cx="20" cy="20" r="4" fill="${t.green}"/>
        <text class="sans" x="32" y="25" font-size="${fontSize}"><tspan fill="${t.soft}" font-weight="600">${esc(cert.title)}</tspan>${cert.issuer ? `<tspan fill="${t.muted}"> · ${esc(cert.issuer)}</tspan>` : ''}</text>
      </g>`
      x += width + gap
      return shape
    })
    return { markup: shapes.join('\n      '), width: x }
  }

  const rowMarkup = rows.map((row, i) => {
    const { markup, width } = pills(row)
    const seconds = Math.round(width / 35)
    const direction = i === 0 ? 'left' : 'right'
    return `<g class="row row${i + 1}">
    <g style="animation:${direction} ${seconds}s linear infinite;--w:-${width}px">
      <g>${markup}</g>
      <g transform="translate(${width} 0)">${markup}</g>
      <g transform="translate(${width * 2} 0)">${markup}</g>
    </g>
  </g>`
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="150" viewBox="0 0 1000 150" role="img" aria-labelledby="title desc">
  <title id="title">Certifications</title>
  <desc id="desc">${esc(certs.map(cert => (cert.issuer ? `${cert.title} (${cert.issuer})` : cert.title)).join(', '))}.</desc>
  <defs>
    <linearGradient id="fade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".08" stop-color="#fff"/>
      <stop offset=".92" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </linearGradient>
    <mask id="edges"><rect width="1000" height="150" fill="url(#fade)"/></mask>
  </defs>
  <style>${FONTS}
    .row1 { transform: translate(0px, 22px); }
    .row2 { transform: translate(0px, 88px); }
    @media (max-width: 640px) {
      .row1 { transform: translate(0px, 4px) scale(1.75); }
      .row2 { transform: translate(0px, 78px) scale(1.75); }
    }
    @keyframes left { from { transform: translateX(0) } to { transform: translateX(var(--w)) } }
    @keyframes right { from { transform: translateX(var(--w)) } to { transform: translateX(0) } }
  </style>
  <g mask="url(#edges)">
  ${rowMarkup.join('\n  ')}
  </g>
</svg>
`
}

// ── LeetCode card ──────────────────────────────────────────────────

function leetcode(t, data, stats) {
  const { solved, total } = stats
  const levels = [
    { key: 'easy', label: 'Easy', color: t.easy },
    { key: 'medium', label: 'Medium', color: t.medium },
    { key: 'hard', label: 'Hard', color: t.hard },
  ]

  // Ring: the solved problems split by difficulty, each segment drawing itself in turn.
  const radius = 70
  const circumference = 2 * Math.PI * radius
  let offset = 0
  const segments = levels
    .map((level, i) => {
      const length = solved.all ? (solved[level.key] / solved.all) * circumference : 0
      const visible = Math.max(0, length - 4)
      const segment = `<circle cx="140" cy="110" r="${radius}" fill="none" stroke="${level.color}" stroke-width="12" stroke-linecap="round"
      stroke-dasharray="${visible.toFixed(1)} ${circumference.toFixed(1)}" transform="rotate(${(-90 + (offset / circumference) * 360).toFixed(1)} 140 110)"
      style="--len:${visible.toFixed(1)};animation:seg 1s ease-out ${(0.2 + i * 0.5).toFixed(1)}s both"/>`
      offset += length
      return segment
    })
    .join('\n    ')

  const tiles = levels
    .map((level, i) => {
      const x = 290 + i * 230
      const percent = total[level.key] ? ((solved[level.key] / total[level.key]) * 100).toFixed(1) : '0'
      return `<g class="tile" style="animation-delay:${(0.4 + i * 0.2).toFixed(1)}s">
      <rect x="${x}" y="86" width="210" height="100" rx="12" fill="${t.panel}" stroke="${t.line}"/>
      <rect x="${x}" y="86" width="210" height="4" rx="2" fill="${level.color}"/>
      <text class="sans label" x="${x + 18}" y="118" fill="${level.color}" font-weight="600">${level.label}</text>
      <text class="sans count" x="${x + 18}" y="164" fill="${t.text}" font-weight="700">${solved[level.key]}</text>
      <text class="sans wide" x="${x + 192}" y="164" font-size="13" fill="${t.muted}" text-anchor="end">/ ${total[level.key]} · ${percent}%</text>
    </g>`
    })
    .join('\n    ')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="220" viewBox="0 0 1000 220" role="img" aria-labelledby="title desc">
  <title id="title">LeetCode: ${solved.all} problems solved</title>
  <desc id="desc">${levels.map(level => `${solved[level.key]} ${level.label.toLowerCase()}`).join(', ')}, user ${esc(data.leetcode.username)}.</desc>
  <style>${FONTS}${LAYOUT_SWITCH}
    .label { font-size: 15px; } .count { font-size: 34px; } .title { font-size: 22px; } .handle { font-size: 15px; }
    .ring-count { font-size: 38px; } .ring-label { font-size: 14px; }
    @media (max-width: 640px) {
      .label { font-size: 28px; } .count { font-size: 40px; } .title { font-size: 34px; } .handle { display: none; }
      .ring-count { font-size: 46px; } .ring-label { font-size: 24px; }
    }
    @keyframes seg { from { stroke-dasharray: 0 ${circumference.toFixed(1)} } to { stroke-dasharray: var(--len) ${circumference.toFixed(1)} } }
    .tile { opacity: 0; animation: rise .6s ease-out forwards; }
    @keyframes rise { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: none } }
    .spin { animation: spin 12s linear infinite; transform-origin: 140px 110px; }
    @keyframes spin { to { transform: rotate(360deg) } }
  </style>

  <rect x="1.5" y="1.5" width="997" height="217" rx="16" fill="${t.bg}" stroke="${t.line}" stroke-width="1.5"/>

  <circle cx="140" cy="110" r="${radius}" fill="none" stroke="${t.track}" stroke-width="12"/>
  <circle class="spin" cx="140" cy="110" r="88" fill="none" stroke="${t.medium}" stroke-opacity=".35" stroke-width="1.5" stroke-dasharray="4 10"/>
  ${segments}
  <text class="sans ring-count" x="140" y="118" font-weight="700" fill="${t.text}" text-anchor="middle">${solved.all}</text>
  <text class="sans ring-label" x="140" y="146" fill="${t.muted}" text-anchor="middle">solved</text>

  <text class="sans title" x="290" y="58" font-weight="700" fill="${t.text}">LeetCode</text>
  <text class="mono handle" x="400" y="57" fill="${t.muted}">@${esc(data.leetcode.username)}</text>
  ${tiles}
</svg>
`
}

// ── Divider ────────────────────────────────────────────────────────

const divider = t => `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="12" viewBox="0 0 1000 12" role="img" aria-label="Section divider">
  <defs>
    <linearGradient id="line" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="500" y2="0" spreadMethod="reflect">
      <stop offset="0" stop-color="${t.blue}" stop-opacity="0"/><stop offset="0.5" stop-color="${t.blue}"/>
      <stop offset="0.75" stop-color="${t.purple}"/><stop offset="1" stop-color="${t.pink}" stop-opacity="0"/>
      <animate attributeName="x1" values="-500;500" dur="4s" repeatCount="indefinite"/>
      <animate attributeName="x2" values="0;1000" dur="4s" repeatCount="indefinite"/>
    </linearGradient>
  </defs>
  <rect x="0" y="5" width="1000" height="2" rx="1" fill="${t.track}"/>
  <rect x="0" y="5" width="1000" height="2" rx="1" fill="url(#line)"/>
</svg>
`

// ── LeetCode data ──────────────────────────────────────────────────

async function fetchLeetCode(username, cached) {
  const query = `query($u: String!) {
    allQuestionsCount { difficulty count }
    matchedUser(username: $u) { submitStatsGlobal { acSubmissionNum { difficulty count } } }
  }`
  try {
    const response = await fetch('https://leetcode.com/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Referer: 'https://leetcode.com' },
      body: JSON.stringify({ query, variables: { u: username } }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const { data } = await response.json()
    const toCounts = list => Object.fromEntries(list.map(entry => [entry.difficulty.toLowerCase(), entry.count]))
    const stats = {
      solved: toCounts(data.matchedUser.submitStatsGlobal.acSubmissionNum),
      total: toCounts(data.allQuestionsCount),
    }
    if (!Number.isFinite(stats.solved.all)) throw new Error('unexpected response shape')
    return stats
  } catch (error) {
    console.warn(`LeetCode unavailable (${error.message}); keeping the cached numbers.`)
    return cached
  }
}

// ── README dynamic values ──────────────────────────────────────────

/** Replaces the text between <!--years--> and <!--/years--> markers. */
const updateReadme = (readme, years) => readme.replace(/(<!--years-->)[\s\S]*?(<!--\/years-->)/g, `$1${years}$2`)

// ── Main ───────────────────────────────────────────────────────────

const data = JSON.parse(await readFile(file('data/profile.json'), 'utf8'))
const cachedStats = JSON.parse(await readFile(file('data/leetcode.json'), 'utf8'))

const today = process.env.PROFILE_NOW ? new Date(process.env.PROFILE_NOW) : new Date()
const now = { year: today.getUTCFullYear(), month: today.getUTCMonth() + 1 }
const years = experienceLabel(parseMonth(data.careerStart), now)

const stats = await fetchLeetCode(data.leetcode.username, cachedStats)
await writeFile(file('data/leetcode.json'), `${JSON.stringify(stats, null, 2)}\n`)

await mkdir(file('assets/'), { recursive: true })
for (const [name, theme] of Object.entries(THEMES)) {
  await writeFile(file(`assets/header-${name}.svg`), header(theme, data, years))
  await writeFile(file(`assets/timeline-${name}.svg`), timeline(theme, data))
  await writeFile(file(`assets/certifications-${name}.svg`), certifications(theme, data))
  await writeFile(file(`assets/leetcode-${name}.svg`), leetcode(theme, data, stats))
  await writeFile(file(`assets/divider-${name}.svg`), divider(theme))
}

const readmePath = file('README.md')
const readme = await readFile(readmePath, 'utf8')
const updated = updateReadme(readme, years)
if (updated !== readme) await writeFile(readmePath, updated)

console.log(`Built assets: ${years} of experience, ${stats.solved.all} LeetCode problems solved.`)
