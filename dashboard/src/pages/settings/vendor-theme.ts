// Phase 33 Plan 06 (D-02) — vendor → color band mapping shared by HeadCard +
// ChannelRow. The color values match the bands in the legacy ChannelsTab.tsx
// verbatim so the visual identity stays consistent across the two UIs while
// the legacy tab is being retired (D-03).
//
// Tailwind purge does not keep arbitrary `bg-[#hex]/5` classes unless they're
// in the safelist. To avoid touching tailwind.config.js, we expose inline
// `style` objects using hex-with-alpha codes — `#5865F20d` ≈ 5% alpha,
// `#5865F2b3` ≈ 70% alpha. Tailwind never sees these strings.
import type React from 'react'

export type Vendor = 'telegram' | 'discord' | 'slack' | 'whatsapp' | 'zoho-cliq'

export const VENDORS: readonly Vendor[] = ['telegram', 'discord', 'slack', 'whatsapp', 'zoho-cliq'] as const

export const VENDOR_COLORS: Record<Vendor, string> = {
  discord:     '#5865F2',
  telegram:    '#0088CC',
  slack:       '#611f69',
  whatsapp:    '#25d366',
  'zoho-cliq': '#e42527',
}

export const VENDOR_LABELS: Record<Vendor, string> = {
  discord:     'Discord',
  telegram:    'Telegram',
  slack:       'Slack',
  whatsapp:    'WhatsApp',
  'zoho-cliq': 'Zoho Cliq',
}

/**
 * Returns inline `style` objects for the vendor's color band — backgroundColor
 * at ~5% alpha and borderColor at ~70% alpha (matching the existing
 * `bg-[#…]/5 border border-[#…]/70` pattern in ChannelsTab.tsx).
 */
export function vendorTheme(vendor: Vendor): { wrapperStyle: React.CSSProperties; labelStyle: React.CSSProperties } {
  const color = VENDOR_COLORS[vendor]
  return {
    wrapperStyle: { backgroundColor: `${color}0d`, borderColor: `${color}b3` },
    labelStyle: { color },
  }
}
