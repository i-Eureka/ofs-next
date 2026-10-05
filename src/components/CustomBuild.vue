<script setup lang="ts">
import { ref, computed, watch, onUnmounted, nextTick } from 'vue'
import { useI18nStore } from '@/stores/i18n'
import { useFirmwareStore } from '@/stores/firmware'
import { useModuleStore } from '@/stores/module'
import { usePackageStore } from '@/stores/package'
import { useCustomBuildStore, type CustomBuildSnapshot, type CustomRepository } from '@/stores/customBuild'
import { AsuService, type AsuBuildRequest, type AsuBuildResponse } from '@/services/asu'
import { config } from '@/config'
import { packageManager } from '@/services/packageManager'
import type { OpenWrtPackage } from '@/types/package'
import ModuleSource from './ModuleSource.vue'
import ModuleSelector from './ModuleSelector.vue'
import PackageManager from './PackageManager.vue'
import PackageDetailDialog from './PackageDetailDialog.vue'

// Define emits
const emit = defineEmits<{
  'build-start': []
  'build-success': [buildResult: AsuBuildResponse & { asu_image_url: string }]
  'build-error': [error: string]
  'build-reset': []
}>()

const i18n = useI18nStore()
const firmware = useFirmwareStore()
const moduleStore = useModuleStore()
const packageStore = usePackageStore()
const customBuildStore = useCustomBuildStore()
const asuService = new AsuService()

function translate(key: string, fallback: string, replacements?: Record<string, string>) {
  let text = i18n.t(key, fallback)
  if (replacements) {
    for (const [token, value] of Object.entries(replacements)) {
      text = text.replace(new RegExp(`{${token}}`, 'g'), value)
    }
  }
  return text
}

// Form data managed via store
const uciDefaultsContent = computed<string>({
  get: () => customBuildStore.uciDefaults,
  set: (value) => customBuildStore.setUciDefaults(value)
})

const rootfsSizeMb = computed<number | null>({
  get: () => customBuildStore.rootfsSizeMb,
  set: (value) => customBuildStore.setRootfsSize(value ?? null)
})

const repositories = computed<CustomRepository[]>({
  get: () => customBuildStore.repositories,
  set: (value) => customBuildStore.setRepositories(value)
})

const repositoryKeys = computed<string[]>({
  get: () => customBuildStore.repositoryKeys,
  set: (value) => customBuildStore.setRepositoryKeys(value)
})

const expandedPanels = ref<number[]>([])

watch(() => customBuildStore.hasCustomData, (hasData, previous) => {
  if (hasData && expandedPanels.value.length === 0 && !previous) {
    expandedPanels.value = [0]
  }
}, { immediate: true })

// Build state
const buildStatus = ref<AsuBuildResponse | null>(null)
const isBuilding = ref(false)
const buildError = ref('')
const pollInterval = ref<number | null>(null)
const expandedLogPanels = ref<string[]>([])
const stderrLogRef = ref<HTMLElement | null>(null)
const stdoutLogRef = ref<HTMLElement | null>(null)

// Validation error dialog
const showValidationErrorDialog = ref(false)
const validationErrors = ref<{ [moduleKey: string]: string[] }>({})

// Package detail dialog
const showPackageDetail = ref(false)
const selectedPackageDetail = ref<OpenWrtPackage | null>(null)

// Computed
const isAsuAvailable = computed(() => asuService.isAvailable())


const finalPackages = computed(() => {
  if (!firmware.selectedProfile) return []
  
  // Collect packages from package manager (includes both selected and removed packages with - prefix)
  const managerPackages = packageStore.buildPackagesList
  
  // Collect packages from selected modules (if module management is enabled)
  const modulePackages: string[] = []
  if (config.enable_module_management) {
    for (const { module } of moduleStore.selectedModules) {
      if (module.definition.packages) {
        modulePackages.push(...module.definition.packages)
      }
    }
  }
  
  return asuService.buildPackagesList(
    firmware.selectedProfile.device_packages || [],
    firmware.selectedProfile.default_packages || [],
    [], // No manual packages text input anymore
    [...(config.asu_extra_packages || []), ...modulePackages, ...managerPackages]
  )
})


const statusMessage = computed(() => {
  if (!buildStatus.value) return ''

  const httpStatus = (buildStatus.value as (AsuBuildResponse & { httpStatus?: number })).httpStatus
  if (httpStatus === 202) {
    return `${i18n.t('tr-building-image', 'Generating firmware image')} · HTTP 202`
  }
  if (httpStatus === 200) {
    return `${i18n.t('tr-build-successful', 'Build successful')} · HTTP 200`
  }
  if (httpStatus && httpStatus >= 400) {
    const detail = buildStatus.value.detail
    const base = detail && detail.length > 0 ? detail : i18n.t('tr-build-failed', 'Build failed')
    return `${base} · HTTP ${httpStatus}`
  }

  const statusMessages: Record<string, string> = {
    requested: i18n.t('tr-init', 'Received build request'),
    building: i18n.t('tr-building-image', 'Generating firmware image'),
    success: i18n.t('tr-build-successful', 'Build successful'),
    failure: i18n.t('tr-build-failed', 'Build failed'),
    no_sysupgrade: translate('custom-no-sysupgrade', 'Device does not support sysupgrade')
  }

  return statusMessages[buildStatus.value.status] || buildStatus.value.status
})

const statusAlertType = computed(() => {
  if (!buildStatus.value) return 'info'
  const httpStatus = (buildStatus.value as (AsuBuildResponse & { httpStatus?: number })).httpStatus
  if (httpStatus === 200) return 'success'
  if (httpStatus === 202 || httpStatus === undefined || httpStatus === null) {
    // fall back to status field when code missing
    const status = buildStatus.value.status
    if (status === 'success') return 'success'
    if (status === 'failure') return 'error'
    return 'info'
  }
  if (httpStatus >= 400) return 'error'
  return 'info'
})

const canBuild = computed(() => {
  return !isBuilding.value && 
         firmware.selectedDevice && 
         firmware.selectedProfile &&
         isAsuAvailable.value
})

// Watch for device changes
watch(
  () => firmware.selectedDevice,
  (newDevice, oldDevice) => {
    if (!oldDevice) return
    resetCustomConfiguration()
  }
)

watch(
  () => firmware.currentVersion,
  (newVersion, oldVersion) => {
    if (oldVersion && newVersion !== oldVersion) {
      resetCustomConfiguration()
    }
  }
)

watch(
  () => [buildStatus.value?.stderr, buildStatus.value?.stdout],
  ([stderr, stdout]) => {
    const panels: string[] = []
    if (stderr) panels.push('stderr')
    if (stdout) panels.push('stdout')
    expandedLogPanels.value = panels
    nextTick(() => {
      scrollToBottom(stderrLogRef.value)
      scrollToBottom(stdoutLogRef.value)
    })
  },
  { immediate: true }
)

function scrollToBottom(element: HTMLElement | null) {
  if (!element) return
  element.scrollTop = element.scrollHeight
}

// Helper functions
function getModuleDisplayName(moduleKey: string): string {
  const [sourceId, moduleId] = moduleKey.split(':')
  const source = moduleStore.sources.find(s => s.id === sourceId)
  const module = source?.modules.find(m => m.id === moduleId)
  
  if (module && source) {
    return translate('custom-module-label', '{name} (Source: {source})', {
      name: module.definition.name,
      source: source.name
    })
  }
  
  return moduleKey
}

function closeValidationErrorDialog() {
  showValidationErrorDialog.value = false
  validationErrors.value = {}
}

function resetCustomConfiguration() {
  stopPolling()
  buildStatus.value = null
  buildError.value = ''
  expandedLogPanels.value = []
  showValidationErrorDialog.value = false
  validationErrors.value = {}
  showPackageDetail.value = false
  selectedPackageDetail.value = null

  customBuildStore.reset()

  if (config.enable_module_management) {
    moduleStore.resetAll()
  }
}

// Get current custom build configuration for saving
function getCurrentCustomBuildConfig() {
  return customBuildStore.getSnapshot()
}

// Apply custom build configuration from loaded config
function applyCustomBuildConfig(customBuild: Record<string, unknown>) {
  customBuildStore.applySnapshot(customBuild as Partial<CustomBuildSnapshot>)
}

// Note: Configuration management is now handled at the App level

// Expose methods for configuration management
defineExpose({
  getCurrentCustomBuildConfig,
  applyCustomBuildConfig
})

// Methods
async function requestBuild() {
  if (!firmware.selectedDevice || !firmware.selectedProfile) return
  
  // Validate all selected modules first (if module management is enabled)
  if (config.enable_module_management) {
    const validationResult = moduleStore.validateAllSelections()
    if (!validationResult.isValid) {
      validationErrors.value = validationResult.errors
      showValidationErrorDialog.value = true
      return
    }
  }
  
  isBuilding.value = true
  buildError.value = ''
  
  // Notify parent that build has started
  emit('build-start')
  
  try {
    // Prepare repositories
    const repoMap: { [name: string]: string } = {}
    repositories.value.forEach(repo => {
      if (repo.name && repo.url) {
        repoMap[repo.name] = repo.url
      }
    })

    // Prepare repository keys
    const repoKeys = repositoryKeys.value
      .map(key => key.trim())
      .filter(key => key.length > 0)

    // Prepare module data if any modules are selected and module management is enabled
    let modules = undefined
    if (config.enable_module_management && moduleStore.selectedModules.length > 0) {
      interface ModuleData {
        source_id: string
        url: string
        ref: string
        selected_modules: Array<{
          module_id: string
          parameters: { [key: string]: string }
          user_downloads: { [key: string]: string }
        }>
      }
      
      const moduleData = new Map<string, ModuleData>()
      
      for (const { module, source, selection } of moduleStore.selectedModules) {
        if (!moduleData.has(source.id)) {
          moduleData.set(source.id, {
            source_id: source.id,
            url: source.url,
            ref: source.ref,
            selected_modules: []
          })
        }
        
        moduleData.get(source.id)!.selected_modules.push({
          module_id: module.id,
          parameters: selection.parameters,
          user_downloads: selection.userDownloads
        })
      }
      
      modules = Array.from(moduleData.values())
    }

    const request: AsuBuildRequest = {
      target: firmware.selectedDevice.target,
      profile: firmware.selectedDevice.id,
      packages: finalPackages.value,
      version: firmware.selectedProfile.version_number,
      defaults: uciDefaultsContent.value || undefined,
      rootfs_size_mb: rootfsSizeMb.value || undefined,
      repositories: Object.keys(repoMap).length > 0 ? repoMap : undefined,
      repository_keys: repoKeys.length > 0 ? repoKeys : undefined,
      modules
    }
    
    const response = await asuService.requestBuild(request)
    buildStatus.value = response
    
    if (response.request_hash) {
      startPolling(response.request_hash)
    }
    
  } catch (error) {
    const errorMsg = translate('custom-build-request-failed', 'Build request failed: {error}', {
      error: String(error)
    })
    buildError.value = errorMsg
    emit('build-error', errorMsg)
  } finally {
    isBuilding.value = false
  }
}

function startPolling(requestHash: string) {
  stopPolling()
  
  pollInterval.value = window.setInterval(async () => {
    try {
      const status = await asuService.getBuildStatus(requestHash)
      buildStatus.value = status
      
      // Use HTTP status code to determine build state (like original implementation)
      if (status.httpStatus === 200) {
        // Build successful
        stopPolling()
        // Use bin_dir from response if available, otherwise use request_hash
        const binDir = status.bin_dir || requestHash
        const buildResult = {
          ...status,
          asu_image_url: `${config.asu_url}/store/${binDir}`
        }
        emit('build-success', buildResult)
      } else if (status.httpStatus === 202) {
        // Build in progress - continue polling
        // No action needed, just continue
      } else if (status.httpStatus >= 400) {
        // Build failed
        stopPolling()
        emit('build-error', status.detail || translate('custom-build-failed-http', 'Build failed (HTTP {status})', { status: String(status.httpStatus) }))
      }
    } catch (error) {
      console.error('Failed to poll build status:', error)
      stopPolling()
      emit('build-error', translate('custom-build-status-failed', 'Failed to poll build status: {error}', { error: String(error) }))
    }
  }, 5000)
}

function stopPolling() {
  if (pollInterval.value) {
    clearInterval(pollInterval.value)
    pollInterval.value = null
  }
}

function resetBuild() {
  buildStatus.value = null
  buildError.value = ''
  stopPolling()
  emit('build-reset')
}

function loadTemplate() {
  // Load a sample uci-defaults template
  uciDefaultsContent.value = `#!/bin/sh
# This script will be executed once after the first boot

# Example: Set hostname
uci set system.@system[0].hostname='OpenWrt-Custom'

# Example: Configure network
# uci set network.lan.ipaddr='192.168.1.1'

# Commit changes
uci commit
`
}

// Repository management methods
function addRepository() {
  customBuildStore.addRepository()
}

async function loadRepositoryIndex(index: number) {
  const repo = repositories.value[index]
  if (!repo || !repo.url) return

  customBuildStore.updateRepository(index, { loading: true, error: undefined })
  
  try {
    // Ensure the URL ends with the version-appropriate index file name
    const fileName = packageManager.getPackageIndexFileName(firmware.currentVersion || '')
    let feedUrl = repo.url.trim()
    if (!feedUrl.endsWith(`/${fileName}`)) {
      if (!feedUrl.endsWith('/')) {
        feedUrl += '/'
      }
      feedUrl += fileName
    }
    
    const packages = await packageManager.fetchFeedPackages(feedUrl, repo.name || 'custom')
    customBuildStore.updateRepository(index, { packages, loading: false })

    // Add these packages to the main package store for browsing
    const current = repositories.value[index]
    packageStore.addCustomFeedPackages((current?.name || repo.name || 'custom'), packages)
  } catch (error) {
    customBuildStore.updateRepository(index, {
      error: error instanceof Error ? error.message : translate('custom-repo-load-error', 'Failed to load'),
      loading: false
    })
    console.error('Failed to load repository index:', error)
  }
}

// Watch for URL changes and auto-load when both name and url are filled
watch(repositories, async (newRepos, oldRepos) => {
  for (let i = 0; i < newRepos.length; i++) {
    const newRepo = newRepos[i]
    const oldRepo = oldRepos?.[i]
    
    // Auto-load when both name and url are filled
    if (newRepo.name.trim() && newRepo.url.trim() &&
        !newRepo.loading && !newRepo.packages) {
      await loadRepositoryIndex(i)
    }
  }
}, { deep: true })

function removeRepository(index: number) {
  const repo = repositories.value[index]
  
  // Remove packages from package store if they were loaded
  if (repo && repo.name && repo.packages) {
    packageStore.removeCustomFeedPackages(repo.name)
  }
  
  customBuildStore.removeRepository(index)
}

// Repository keys management methods
function addRepositoryKey() {
  customBuildStore.addRepositoryKey()
}

function removeRepositoryKey(index: number) {
  customBuildStore.removeRepositoryKey(index)
}

// Package detail methods
function showPackageDetails(packageName: string) {
  const packageInfo = packageStore.getPackageInfo(packageName)
  selectedPackageDetail.value = packageInfo || null
  showPackageDetail.value = true
}



// Cleanup
onUnmounted(() => {
  stopPolling()
})
</script>

<template>
  <v-expansion-panels v-if="isAsuAvailable" v-model="expandedPanels">
    <v-expansion-panel>
      <v-expansion-panel-title>
        <div class="d-flex align-center">
          <v-icon class="mr-3">mdi-cog</v-icon>
          <span>{{ i18n.t('tr-customize', 'Customize installed packages and/or first boot script') }}</span>
        </div>
      </v-expansion-panel-title>
      
      <v-expansion-panel-text>
        <!-- Module Management -->
        <div v-if="config.enable_module_management" class="mb-6">
          <ModuleSource class="mb-4" />
          <ModuleSelector v-if="moduleStore.sources.length > 0" />
        </div>

        <v-divider v-if="config.enable_module_management" class="my-6" />

        <v-row>
          <!-- Package Manager -->
          <v-col cols="12">
            <PackageManager class="mb-6" />
          </v-col>


          <!-- UCI Defaults Script -->
          <v-col cols="12">
            <div class="d-flex align-center justify-space-between mb-3">
              <h4 class="text-h6">{{ i18n.t('tr-defaults', 'Script to run on first boot (uci-defaults)') }}</h4>
              <v-btn
                size="small"
                variant="outlined"
                @click="loadTemplate"
              >
                {{ i18n.t('custom-load-template', 'Load Template') }}
              </v-btn>
            </div>
            <v-textarea
              v-model="uciDefaultsContent"
              rows="10"
              variant="outlined"
              :placeholder="i18n.t('custom-defaults-placeholder', 'Enter first boot script content')"
              :hint="i18n.t('custom-defaults-hint', 'This script runs once on first boot')"
              persistent-hint
            />
          </v-col>
        </v-row>

        <v-divider class="my-6" />

        <!-- Advanced Configuration -->
        <v-row>
          <v-col cols="12">
            <h4 class="text-h6 mb-3">{{ i18n.t('custom-advanced-settings', 'Advanced Settings') }}</h4>
          </v-col>

          <!-- Root Filesystem Size -->
          <v-col cols="12" md="6">
            <v-text-field
              v-model.number="rootfsSizeMb"
              :label="i18n.t('custom-rootfs-label', 'Root filesystem size (MiB)')"
              placeholder="256"
              type="number"
              variant="outlined"
              :hint="i18n.t('custom-rootfs-hint', 'Set the root filesystem size in MiB (optional)')"
              persistent-hint
              :min="1"
              :max="2048"
              clearable
            />
          </v-col>

          <!-- Repositories -->
          <v-col cols="12">
            <div class="d-flex align-center mb-3">
              <h5 class="text-subtitle1">{{ i18n.t('custom-repo-title', 'Custom Feeds') }}</h5>
              <v-spacer />
              <v-btn
                size="small"
                prepend-icon="mdi-plus"
                @click="addRepository"
              >
                {{ i18n.t('custom-repo-add', 'Add Feed') }}
              </v-btn>
            </div>
            
            <div v-if="repositories.length === 0" class="text-grey text-body-2 mb-4">
              {{ i18n.t('custom-repo-empty', 'No custom feeds yet') }}
            </div>

            <v-card v-for="(repo, index) in repositories" :key="index" variant="outlined" class="mb-3">
              <v-card-title class="d-flex align-center pa-3">
                <v-icon icon="mdi-package-variant" class="mr-2" />
                {{ translate('custom-repo-item', 'Feed {index}', { index: String(index + 1) }) }}
                <v-spacer />
                <v-btn
                  icon="mdi-delete"
                  variant="text"
                  color="error"
                  size="small"
                  @click="removeRepository(index)"
                />
              </v-card-title>
              
              <v-card-text class="pt-0">
                <v-row>
                  <v-col cols="12" md="4">
                    <v-text-field
                      v-model="repo.name"
                      :label="i18n.t('custom-repo-name-label', 'Feed name')"
                      variant="outlined"
                      density="compact"
                      placeholder="my-repo"
                    />
                  </v-col>
                  <v-col cols="12" md="8">
                    <v-text-field
                      v-model="repo.url"
                      :label="i18n.t('custom-repo-url-label', 'Feed URL')"
                      variant="outlined"
                      density="compact"
                      placeholder="https:&sol;&sol;downloads.example.com/packages/Packages"
                      :loading="repo.loading"
                      :error="!!repo.error"
                      :error-messages="repo.error"
                    />
                    <div v-if="repo.packages" class="text-caption text-success mt-1">
                      {{ translate('custom-repo-loaded', '✓ Loaded {count} packages', { count: String(repo.packages.length) }) }}
                    </div>
                  </v-col>
                </v-row>
              </v-card-text>
            </v-card>
          </v-col>

          <!-- Repository Keys -->
          <v-col cols="12">
            <div class="d-flex align-center mb-3">
              <h5 class="text-subtitle1">{{ i18n.t('custom-keys-title', 'Feed Signing Keys') }}</h5>
              <v-spacer />
              <v-btn
                size="small"
                prepend-icon="mdi-plus"
                @click="addRepositoryKey"
              >
                {{ i18n.t('custom-keys-add', 'Add Key') }}
              </v-btn>
            </div>
            
            <div v-if="repositoryKeys.length === 0" class="text-grey text-body-2 mb-4">
              {{ i18n.t('custom-keys-empty', 'No signing keys yet') }}
            </div>

            <v-card v-for="(key, index) in repositoryKeys" :key="index" variant="outlined" class="mb-3">
              <v-card-title class="d-flex align-center pa-3">
                <v-icon icon="mdi-key-variant" class="mr-2" />
                {{ translate('custom-keys-item', 'Signing Key {index}', { index: String(index + 1) }) }}
                <v-spacer />
                <v-btn
                  icon="mdi-delete"
                  variant="text"
                  color="error"
                  size="small"
                  @click="removeRepositoryKey(index)"
                />
              </v-card-title>
              
              <v-card-text class="pt-0">
                <v-textarea
                  v-model="repositoryKeys[index]"
                  :label="i18n.t('custom-keys-label', 'usign Public Key')"
                  variant="outlined"
                  rows="3"
                  density="compact"
                  placeholder="untrusted comment: OpenWrt usign key&#10;RWQKvaZaSStIhx4t06ISyV42CIpK7niKfR+Yro/WHiKLa122SEh2j3Z4"
                  :hint="i18n.t('custom-keys-hint', 'usign public key used to verify custom feeds')"
                  persistent-hint
                />
              </v-card-text>
            </v-card>
          </v-col>
        </v-row>

        <!-- Package Summary -->
        <v-card v-if="finalPackages.length > 0" variant="elevated" class="mt-4 mb-4">
          <v-card-title class="text-subtitle1">
            {{ translate('custom-package-summary-title', 'Package Summary ({count})', { count: String(finalPackages.length) }) }}
          </v-card-title>
          <v-card-text>
            <div class="d-flex flex-wrap">
              <v-chip
                v-for="pkg in finalPackages"
                :key="pkg"
                size="small"
                variant="outlined"
                class="ma-1"
                :color="pkg.startsWith('-') ? 'error' : 'primary'"
                :class="{ 'text-decoration-line-through': pkg.startsWith('-') }"
                @click="packageStore.getPackageInfo(pkg.replace(/^-/, '')) ? showPackageDetails(pkg.replace(/^-/, '')) : null"
                :style="packageStore.getPackageInfo(pkg.replace(/^-/, '')) ? 'cursor: pointer' : ''"
              >
                <v-icon 
                  v-if="packageStore.getPackageInfo(pkg.replace(/^-/, ''))" 
                  size="x-small" 
                  class="mr-1"
                >
                  mdi-information-outline
                </v-icon>
                {{ pkg }}
              </v-chip>
            </div>
          </v-card-text>
        </v-card>

        <!-- Build Button -->
        <div class="d-flex justify-center">
          <v-btn
            :disabled="!canBuild"
            :loading="isBuilding"
            color="primary"
            size="large"
            prepend-icon="mdi-hammer-wrench"
            @click="requestBuild"
          >
            {{ i18n.t('tr-request-build', 'REQUEST BUILD') }}
          </v-btn>
        </div>

        <!-- Build Status -->
        <div v-if="buildStatus" class="mt-6">
          <v-alert
            :type="statusAlertType"
            :closable="buildStatus.status !== 'building'"
            @click:close="resetBuild"
          >
            <div class="d-flex align-center">
              <v-progress-circular
                v-if="buildStatus.status === 'building' || buildStatus.status === 'requested'"
                indeterminate
                size="24"
                class="mr-3"
              />
              <div>
                <div>{{ statusMessage }}</div>
                <div v-if="buildStatus.queue_position" class="text-caption">
                  {{ translate('custom-queue-position', 'Queue position: {position}', { position: String(buildStatus.queue_position) }) }}
                </div>
              </div>
            </div>
            
            <!-- Build Success - Show download links -->
            <div v-if="buildStatus.status === 'success' && buildStatus.images" class="mt-3">
              <v-divider class="mb-3" />
              <div class="text-subtitle2 mb-2">{{ i18n.t('tr-custom-downloads', 'Custom Downloads') }}</div>
              <div class="d-flex flex-wrap gap-2">
                <v-btn
                  v-for="image in buildStatus.images"
                  :key="image.name"
                  :href="`${config.asu_url}/store/${buildStatus.request_hash}/${image.name}`"
                  target="_blank"
                  color="success"
                  variant="elevated"
                  size="small"
                  prepend-icon="mdi-download"
                >
                  {{ image.type.toUpperCase() }}
                </v-btn>
              </div>
            </div>
          </v-alert>
        </div>

        <!-- Build Error -->
        <v-alert
          v-if="buildError"
          type="error"
          closable
          class="mt-4"
          @click:close="buildError = ''"
        >
          {{ buildError }}
        </v-alert>

        <!-- Build Logs -->
        <div v-if="buildStatus && (buildStatus.stdout || buildStatus.stderr)" class="mt-6">
          <v-divider class="mb-4" />
          <div class="d-flex align-center mb-2">
            <v-icon icon="mdi-text-box-outline" size="small" class="mr-2" />
            <span class="text-subtitle2">{{ i18n.t('custom-build-log', 'Build Log') }}</span>
          </div>
          <v-expansion-panels
            v-model="expandedLogPanels"
            variant="accordion"
            multiple
          >
            <v-expansion-panel v-if="buildStatus.stderr" value="stderr">
              <v-expansion-panel-title>
                <code>STDERR</code>
              </v-expansion-panel-title>
              <v-expansion-panel-text>
                <pre ref="stderrLogRef" class="build-log">{{ buildStatus.stderr }}</pre>
              </v-expansion-panel-text>
            </v-expansion-panel>

            <v-expansion-panel v-if="buildStatus.stdout" value="stdout">
              <v-expansion-panel-title>
                <code>STDOUT</code>
              </v-expansion-panel-title>
              <v-expansion-panel-text>
                <pre ref="stdoutLogRef" class="build-log">{{ buildStatus.stdout }}</pre>
              </v-expansion-panel-text>
            </v-expansion-panel>
          </v-expansion-panels>
        </div>
      </v-expansion-panel-text>
    </v-expansion-panel>
  </v-expansion-panels>

  <!-- Validation Error Dialog -->
  <v-dialog v-model="showValidationErrorDialog" max-width="600px" scrollable>
    <v-card>
      <v-card-title class="d-flex align-center">
        <v-icon icon="mdi-alert-circle" color="error" class="mr-2" />
        {{ i18n.t('custom-validation-title', 'Module Parameter Validation Failed') }}
      </v-card-title>

      <v-divider />

      <v-card-text class="pt-4">
        <v-alert type="error" variant="tonal" class="mb-4">
          <strong>{{ i18n.t('custom-validation-intro', 'Cannot start build because the following modules have parameter errors:') }}</strong>
        </v-alert>

        <div v-for="(errors, moduleKey) in validationErrors" :key="moduleKey" class="mb-4">
          <div class="d-flex align-center mb-2">
            <v-icon icon="mdi-puzzle" size="small" color="primary" class="mr-2" />
            <strong>{{ getModuleDisplayName(String(moduleKey)) }}</strong>
          </div>
          
          <v-list density="compact" class="bg-error-container/10 rounded">
            <v-list-item
              v-for="(error, index) in errors"
              :key="index"
              class="text-error"
            >
              <template #prepend>
                <v-icon icon="mdi-circle-small" size="small" />
              </template>
              <v-list-item-title class="text-body-2">{{ error }}</v-list-item-title>
            </v-list-item>
          </v-list>
        </div>

        <v-alert type="info" variant="tonal" class="mt-4">
          <div class="text-body-2">
            <strong>{{ i18n.t('custom-validation-solutions-title', 'How to fix:') }}</strong>
            <ul class="mt-2">
              <li>{{ i18n.t('custom-validation-solution-required', 'Fill in all required parameters highlighted in red') }}</li>
              <li>{{ i18n.t('custom-validation-solution-format', 'Ensure parameter formats are valid (IP addresses, URLs, etc.)') }}</li>
              <li>{{ i18n.t('custom-validation-solution-url', 'Provide valid URLs for user-defined downloads') }}</li>
              <li>{{ i18n.t('custom-validation-solution-config', 'Open the "Configure Parameters" dialog for the module to fix issues') }}</li>
            </ul>
          </div>
        </v-alert>
      </v-card-text>

      <v-card-actions>
        <v-spacer />
        <v-btn @click="closeValidationErrorDialog">{{ i18n.t('common-close', 'Close') }}</v-btn>
        <v-btn 
          color="primary" 
          variant="outlined"
          @click="closeValidationErrorDialog"
        >
          {{ i18n.t('custom-validation-fix', 'Fix Parameters') }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>

  <!-- Package Detail Dialog -->
  <PackageDetailDialog 
    v-model="showPackageDetail"
    :package-detail="selectedPackageDetail"
  />
</template>

<style scoped>
.build-log {
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  font-size: 0.875rem;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 300px;
  overflow-y: auto;
}
</style>
