export interface Config {
  // Brand name
  brand_name: string

  // Homepage URL (for logo link)
  homepage_url: string

  // Show help text for images
  show_help: boolean

  // Versions list (optional if provided by .versions.json)
  versions: string[]

  // Pre-selected version (optional if provided by .versions.json)
  default_version: string

  // Image download URL (e.g. "https://downloads.openwrt.org")
  image_url: string

  // Insert snapshot versions (optional)
  show_snapshots?: boolean

  // Info link URL (optional)
  info_url?: string

  // Attended Sysupgrade Server support (optional)
  asu_url?: string
  asu_extra_packages?: string[]

  // Enable/disable module management feature (optional)
  enable_module_management?: boolean

  // Override list of versions that use apk v3 package index (packages.adb).
  // Releases 25.12 and newer are treated as apk-based automatically.
  apk_versions?: string[]
}

export const config: Config = {
  // Brand name
  brand_name: "ImmortalWrt",

  // Homepage URL (for logo link)
  homepage_url: "https://immortalwrt.org/",

  // Show help text for images
  show_help: true,

  // Versions list (optional if provided by .versions.json)
  versions: ["23.05.4", "19.07.10"],

  // Pre-selected version (optional if provided by .versions.json)
  default_version: "23.05.4",

  // Image download URL (e.g. "https://downloads.openwrt.org")
  image_url: "https://downloads.immortalwrt.org",

  // Insert snapshot versions (optional)
  show_snapshots: true,

  // Info link URL (optional)
  info_url: "https://openwrt.org/start?do=search&id=toh&q={title} @toh",

  // Attended Sysupgrade Server support (optional)
  asu_url: "https://sysupgrade.kyarucloud.moe",
  asu_extra_packages: ["luci"],

  // Enable/disable module management feature (optional)
  enable_module_management: false,
  // Extra versions forced to apk v3 index (25.12+ is detected automatically)
  apk_versions: ["SNAPSHOT"]
}
