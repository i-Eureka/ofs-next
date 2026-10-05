// OpenWrt package management service

import type { OpenWrtPackage, PackageFeed, PackageSearchFilter } from '@/types/package'
import { config } from '@/config'
import { useI18nStore } from '@/stores/i18n'

function translate(key: string, fallback: string): string {
  try {
    const store = useI18nStore()
    return store?.t(key, fallback) ?? fallback
  } catch {
    return fallback
  }
}
// Import ADB parser for apk v3 package index
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - JS module export without types
import { parsePackagesAdbFromBytes } from '@/tools/adbdump.js'

export class PackageManagerService {
  private readonly ARCHITECTURE_FEEDS = ['base', 'luci', 'packages', 'telephony']
  private readonly TARGET_FEEDS = ['kmods', 'packages'] // Target-specific feeds

  /**
   * Generate package feed URLs for a device
   */
  generateFeedUrls(version: string, architecture: string, target?: string, kernelInfo?: { version: string; release: string; vermagic: string }): string[] {
    const urls: string[] = []
    const baseUrl = this.isSnapshot(version) ? `${config.image_url}/snapshots` : `${config.image_url}/releases/${version}`
    const fileName = this.getPackageIndexFileName(version)

    // Architecture-specific feeds
    const archUrl = `${baseUrl}/packages/${architecture}`
    this.ARCHITECTURE_FEEDS.forEach(feed => {
      urls.push(`${archUrl}/${feed}/${fileName}`)
    })

    // Target-specific feeds (if target is provided)
    if (target) {
      const targetUrl = `${baseUrl}/targets/${target}`

      // Target packages
      urls.push(`${targetUrl}/packages/${fileName}`)

      // Kernel modules (if kernel info is provided)
      if (kernelInfo) {
        urls.push(`${targetUrl}/kmods/${kernelInfo.version}-${kernelInfo.release}-${kernelInfo.vermagic}/${fileName}`)
      }
    }

    return urls
  }

  /**
   * Fetch and parse packages from a feed URL
   */
  async fetchFeedPackages(feedUrl: string, feedName: string): Promise<OpenWrtPackage[]> {
    try {
      const response = await fetch(feedUrl)
      if (!response.ok) {
        throw new Error(`Failed to fetch packages: ${response.statusText}`)
      }

      // Detect APK v3 ADB index by filename
      if (feedUrl.toLowerCase().endsWith('packages.adb')) {
        const buf = await response.arrayBuffer()
        const decoded: { packages: any[] } = await parsePackagesAdbFromBytes(new Uint8Array(buf))
        return this.mapAdbPackages(decoded.packages || [], feedName)
      } else {
        const packagesText = await response.text()
        return this.parsePackagesFile(packagesText, feedName)
      }
    } catch (error) {
      console.error(`Error fetching packages from ${feedUrl}:`, error)
      throw error
    }
  }

  /**
   * Parse OpenWrt Packages file format
   */
  parsePackagesFile(content: string, source: string): OpenWrtPackage[] {
    const packages: OpenWrtPackage[] = []
    const packageBlocks = content.split('\n\n').filter(block => block.trim())

    for (const block of packageBlocks) {
      try {
        const pkg = this.parsePackageBlock(block, source)
        if (pkg) {
          packages.push(pkg)
        }
      } catch (error) {
        console.warn('Failed to parse package block:', error)
      }
    }

    return packages
  }

  /**
   * Parse a single package block
   */
  private parsePackageBlock(block: string, source: string): OpenWrtPackage | null {
    const lines = block.split('\n')
    const pkg: Partial<OpenWrtPackage> = { source }

    for (const line of lines) {
      const colonIndex = line.indexOf(':')
      if (colonIndex === -1) continue

      const key = line.substring(0, colonIndex).trim()
      const value = line.substring(colonIndex + 1).trim()

      switch (key) {
        case 'Package':
          pkg.name = value
          break
        case 'Version':
          pkg.version = value
          break
        case 'Depends':
          // Parse dependencies (comma-separated, may have version constraints)
          pkg.depends = this.parseDependencies(value)
          break
        case 'License':
          pkg.license = value
          break
        case 'Section':
          pkg.section = value
          break
        case 'URL':
          pkg.url = value
          break
        case 'CPE-ID':
          pkg.cpeId = value
          break
        case 'Architecture':
          pkg.architecture = value
          break
        case 'Installed-Size':
          pkg.installedSize = parseInt(value, 10) || 0
          break
        case 'Filename':
          pkg.filename = value
          break
        case 'Size':
          pkg.size = parseInt(value, 10) || 0
          break
        case 'SHA256sum':
          pkg.sha256sum = value
          break
        case 'Description':
          pkg.description = value
          break
      }
    }

    // Validate required fields
    if (!pkg.name || !pkg.version || !pkg.architecture || !pkg.filename) {
      return null
    }

    return pkg as OpenWrtPackage
  }

  /**
   * Map APK v3 ADB package entries to OpenWrtPackage
   */
  private mapAdbPackages(entries: any[], source: string): OpenWrtPackage[] {
    const out: OpenWrtPackage[] = []
    for (const e of entries) {
      if (!e || !e.name || !e.version || !e.arch) continue
      const name: string = e.name
      const version: string = e.version
      const architecture: string = e.arch
      const size: number = Number(e['file-size'] || 0)
      const installedSize: number = Number(e['installed-size'] || 0)
      const description: string = e.description || ''
      const license: string | undefined = e.license
      const url: string | undefined = e.url
      const sha256sum: string = e.hashes || ''
      const dependsRaw: string[] = Array.isArray(e.depends) ? e.depends : []
      const depends: string[] = dependsRaw
        .map(d => this.cleanAdbDependency(String(d)))
        .filter(d => d && d !== 'libc')

      // ADB index does not include section/filename; provide sensible defaults
      const section = ''
      const filename = `${name}_${version}_${architecture}.apk`

      out.push({
        name,
        version,
        depends,
        license,
        section,
        url,
        architecture,
        installedSize,
        filename,
        size,
        sha256sum,
        description,
        source
      })
    }
    return out
  }

  /** Strip version/op from ADB dependency strings like 'foo>=1.2' or '!bar' */
  private cleanAdbDependency(dep: string): string {
    const m = dep.replace(/^!/, '').match(/^([^<>=~\s]+)/)
    return m ? m[1].trim() : dep.trim()
  }

  /**
   * Parse dependency string
   */
  private parseDependencies(dependsStr: string): string[] {
    if (!dependsStr) return []

    return dependsStr
      .split(',')
      .map(dep => dep.trim())
      .filter(dep => dep && dep !== 'libc') // Filter out libc as it's always available
      .map(dep => {
        // Remove version constraints like "(>= 1.0.0)"
        const match = dep.match(/^([^(]+)/)
        return match ? match[1].trim() : dep
      })
      .filter(dep => dep)
  }

  private isSnapshot(version: string): boolean {
    return version === 'SNAPSHOT' || version.endsWith('-SNAPSHOT')
  }

  /**
   * Whether the version uses the apk v3 index: explicit override list in
   * config.apk_versions, or release 25.12 and newer.
   */
  isApkVersion(version: string): boolean {
    const list = (config as any).apk_versions as string[] | undefined
    if (Array.isArray(list) && list.includes(version)) return true
    if (this.isSnapshot(version)) return false
    const m = version.match(/^(\d+)\.(\d+)/)
    if (!m) return false
    const major = Number(m[1])
    const minor = Number(m[2])
    return major > 25 || (major === 25 && minor >= 12)
  }

  /**
   * Package index file name for a version ('packages.adb' or 'Packages')
   */
  getPackageIndexFileName(version: string): string {
    return this.isApkVersion(version) ? 'packages.adb' : 'Packages'
  }

  /**
   * Search packages with filters
   */
  searchPackages(packages: OpenWrtPackage[], filter: PackageSearchFilter): OpenWrtPackage[] {
    let results = packages

    // Text search
    if (filter.query) {
      const query = filter.query.toLowerCase()
      results = results.filter(pkg =>
        pkg.name.toLowerCase().includes(query) ||
        pkg.description.toLowerCase().includes(query)
      )
    }

    // Section filter
    if (filter.section) {
      results = results.filter(pkg => pkg.section === filter.section)
    }

    // Architecture filter
    if (filter.architecture) {
      results = results.filter(pkg => pkg.architecture === filter.architecture)
    }

    // Source filter
    if (filter.source) {
      results = results.filter(pkg => pkg.source === filter.source)
    }

    return results
  }

  /**
   * Get all unique sections from packages
   */
  getPackageSections(packages: OpenWrtPackage[]): string[] {
    const sections = new Set<string>()
    packages.forEach(pkg => {
      if (pkg.section) {
        sections.add(pkg.section)
      }
    })
    return Array.from(sections).sort()
  }

  /**
   * Calculate dependency tree for a package
   */
  getDependencyTree(packageName: string, packages: OpenWrtPackage[]): string[] {
    const visited = new Set<string>()
    const dependencies: string[] = []

    const addDependencies = (pkgName: string) => {
      if (visited.has(pkgName)) return

      visited.add(pkgName)
      const pkg = packages.find(p => p.name === pkgName)

      if (pkg && pkg.depends) {
        for (const dep of pkg.depends) {
          if (!visited.has(dep)) {
            dependencies.push(dep)
            addDependencies(dep)
          }
        }
      }
    }

    addDependencies(packageName)
    return dependencies
  }

  /**
   * Find packages that depend on a given package
   */
  getDependents(packageName: string, packages: OpenWrtPackage[]): string[] {
    return packages
      .filter(pkg => pkg.depends?.includes(packageName))
      .map(pkg => pkg.name)
  }

  /**
   * Format package size for display
   */
  formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`
  }

  /**
   * Get section display name
   */
  /**
   * Get feed display names
   */
  getFeedDisplayName(feedName: string): string {
    const feedNames: { [key: string]: { key: string, fallback: string } } = {
      'base': { key: 'package-feed-base', fallback: 'Base system' },
      'luci': { key: 'package-feed-luci', fallback: 'LuCI interface' },
      'packages': { key: 'package-feed-packages', fallback: 'Additional packages' },
      'telephony': { key: 'package-feed-telephony', fallback: 'Telephony' },
      'kmods': { key: 'package-feed-kmods', fallback: 'Kernel modules' },
      'target-packages': { key: 'package-feed-target', fallback: 'Target specific packages' }
    }
    const entry = feedNames[feedName]
    if (entry) {
      return translate(entry.key, entry.fallback)
    }
    return feedName
  }

  /**
   * Get section display names
   */
  getSectionDisplayName(section: string): string {
    if (!section) return translate('package-section-none', 'None')
    const sectionNames: { [key: string]: { key: string, fallback: string } } = {
      'admin': { key: 'package-section-admin', fallback: 'Administration' },
      'base': { key: 'package-section-base', fallback: 'Base system' },
      'boot': { key: 'package-section-boot', fallback: 'Boot loaders' },
      'devel': { key: 'package-section-devel', fallback: 'Development' },
      'firmware': { key: 'package-section-firmware', fallback: 'Firmware' },
      'kernel': { key: 'package-section-kernel', fallback: 'Kernel modules' },
      'lang': { key: 'package-section-lang', fallback: 'Languages' },
      'libs': { key: 'package-section-libs', fallback: 'Libraries' },
      'luci': { key: 'package-section-luci', fallback: 'LuCI' },
      'mail': { key: 'package-section-mail', fallback: 'Mail' },
      'multimedia': { key: 'package-section-multimedia', fallback: 'Multimedia' },
      'net': { key: 'package-section-net', fallback: 'Network' },
      'sound': { key: 'package-section-sound', fallback: 'Sound' },
      'system': { key: 'package-section-system', fallback: 'System utilities' },
      'telephony': { key: 'package-section-telephony', fallback: 'Telephony' },
      'text': { key: 'package-section-text', fallback: 'Text processing' },
      'utils': { key: 'package-section-utils', fallback: 'Utilities' },
      'web': { key: 'package-section-web', fallback: 'Web services' }
    }
    const entry = sectionNames[section]
    if (entry) {
      return translate(entry.key, entry.fallback)
    }
    return section
  }
}

export const packageManager = new PackageManagerService()
