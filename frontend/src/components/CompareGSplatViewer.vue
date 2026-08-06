<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { getCompareGSplatApp } from '../lib/gsplatApp'
import type { Vec3 } from '../stores/sceneObjects'

const props = defineProps<{
  src: string[]
  ids: string[]
  transforms: { position: Vec3; rotation: Vec3; scale: Vec3 }[]
  dataRotations: (Vec3 | null)[]
  colors: (string | null)[]
  initialCamera?: { position: Vec3; forward: Vec3 } | null
}>()

const wrapperRef = ref<HTMLDivElement | null>(null)
const loading = ref(true)

let isActive = true
let pcRef: any = null
let appRef: any = null
let cameraRef: any = null
let entityList: { root: any; splat: any; kind: 'gsplat' | 'mesh' }[] = []
let resizeObserver: ResizeObserver | null = null
let ownCanvas: HTMLCanvasElement | null = null

let dragging = false
let lastX = 0
let lastY = 0
let azimuth = -0.5
let elevation = 0.4
let orbitRadius = 5
const orbitTarget = { x: 0, y: 0, z: 0 }

function updateCamera() {
  if (!cameraRef || !pcRef) return
  const pc = pcRef
  const x = orbitTarget.x + orbitRadius * Math.cos(elevation) * Math.sin(azimuth)
  const y = orbitTarget.y + orbitRadius * Math.sin(elevation)
  const z = orbitTarget.z + orbitRadius * Math.cos(elevation) * Math.cos(azimuth)
  cameraRef.setPosition(x, y, z)
  cameraRef.lookAt(new pc.Vec3(orbitTarget.x, orbitTarget.y, orbitTarget.z))
}

function onPointerDown(e: PointerEvent) {
  dragging = true
  lastX = e.clientX
  lastY = e.clientY
  ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
}

function onPointerMove(e: PointerEvent) {
  if (!dragging) return
  azimuth -= (e.clientX - lastX) * 0.01
  elevation = Math.max(-1.4, Math.min(1.4, elevation + (e.clientY - lastY) * 0.01))
  lastX = e.clientX
  lastY = e.clientY
  updateCamera()
}

function onPointerUp() {
  dragging = false
}

function onWheel(e: WheelEvent) {
  e.preventDefault()
  orbitRadius = Math.max(0.3, orbitRadius * (1 + e.deltaY * 0.001))
  updateCamera()
}

function kindForUrl(url: string): 'gsplat' | 'mesh' {
  return url.toLowerCase().endsWith('.glb') ? 'mesh' : 'gsplat'
}

function collectRenderComponents(entity: any, out: any[]) {
  if (entity.render) out.push(entity.render)
  for (const child of entity.children ?? []) collectRenderComponents(child, out)
}

function getWorldAabb(pc: any, splat: any, kind: 'gsplat' | 'mesh'): any {
  if (kind === 'gsplat') {
    const localAabb = splat.gsplat?.customAabb
    if (!localAabb) return null
    const worldAabb = new pc.BoundingBox()
    worldAabb.setFromTransformedAabb(localAabb, splat.getWorldTransform())
    return worldAabb
  }
  const renderComps: any[] = []
  collectRenderComponents(splat, renderComps)
  let combined: any = null
  for (const rc of renderComps) {
    for (const mi of rc.meshInstances ?? []) {
      if (!combined) combined = mi.aabb.clone()
      else combined.add(mi.aabb)
    }
  }
  return combined
}

function hexToRgb01(hex: string) {
  return {
    r: parseInt(hex.slice(1, 3), 16) / 255,
    g: parseInt(hex.slice(3, 5), 16) / 255,
    b: parseInt(hex.slice(5, 7), 16) / 255,
  }
}

function applyColorTint(pc: any, splat: any, kind: 'gsplat' | 'mesh', hex: string) {
  const color = hexToRgb01(hex)
  if (kind === 'mesh') {
    const pcColor = new pc.Color(color.r, color.g, color.b)
    const renderComps: any[] = []
    collectRenderComponents(splat, renderComps)
    for (const rc of renderComps) {
      for (const mi of rc.meshInstances ?? []) {
        const cloned = mi.material.clone()
        cloned.diffuse = pcColor
        cloned.diffuseMap = null
        cloned.update()
        mi.material = cloned
      }
    }
    return
  }
  const resource = splat.gsplat?.resource
  const gsplatData = resource?.gsplatData
  if (!resource || !gsplatData) return
  const texture = resource.streams?.getTexture?.('splatColor')
  if (!texture) return
  const cr = gsplatData.getProp('f_dc_0')
  const cg = gsplatData.getProp('f_dc_1')
  const cb = gsplatData.getProp('f_dc_2')
  const ca = gsplatData.getProp('opacity')
  if (!cr || !cg || !cb || !ca) return
  const SH_C0 = 0.28209479177387814
  const float2Half = pc.FloatPacking.float2Half
  const numSplats = gsplatData.numSplats
  const data = texture.lock()
  for (let i = 0; i < numSplats; i++) {
    const r = cr[i] * SH_C0 + 0.5
    const g = cg[i] * SH_C0 + 0.5
    const b = cb[i] * SH_C0 + 0.5
    const a = gsplatData.activated ? ca[i] : 1 / (1 + Math.exp(-ca[i]))
    const luminance = 0.299 * r + 0.587 * g + 0.114 * b
    const shade = Math.min(2 * luminance, 2)
    data[i * 4 + 0] = float2Half(Math.min(color.r * shade, 1))
    data[i * 4 + 1] = float2Half(Math.min(color.g * shade, 1))
    data[i * 4 + 2] = float2Half(Math.min(color.b * shade, 1))
    data[i * 4 + 3] = float2Half(a)
  }
  texture.unlock()
}

function frameAll() {
  if (!pcRef || !cameraRef || !entityList.length) return
  const pc = pcRef
  let combined: any = null
  for (const { splat, kind } of entityList) {
    const aabb = getWorldAabb(pc, splat, kind)
    if (!aabb) continue
    if (!combined) combined = aabb
    else combined.add(aabb)
  }
  if (!combined) return
  const center = combined.center
  orbitTarget.x = center.x
  orbitTarget.y = center.y
  orbitTarget.z = center.z
  orbitRadius = Math.max(combined.halfExtents.length() * 2.5, 1)
  updateCamera()
}

function initFromCamera(state: { position: Vec3; forward: Vec3 }) {
  const [px, py, pz] = state.position
  const [fx, fy, fz] = state.forward
  const probe = 5
  orbitTarget.x = px + fx * probe
  orbitTarget.y = py + fy * probe
  orbitTarget.z = pz + fz * probe
  const dx = px - orbitTarget.x
  const dy = py - orbitTarget.y
  const dz = pz - orbitTarget.z
  orbitRadius = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 0.3)
  azimuth = Math.atan2(dx, dz)
  elevation = Math.asin(Math.max(-0.999, Math.min(0.999, dy / orbitRadius)))
  updateCamera()
}

onMounted(async () => {
  const wrapper = wrapperRef.value
  if (!wrapper) return

  const { pc, app, canvas, camera } = await getCompareGSplatApp()
  if (!isActive) return

  pcRef = pc
  appRef = app
  cameraRef = camera
  ownCanvas = canvas

  wrapper.appendChild(canvas)

  const resize = () => {
    const { width, height } = wrapper.getBoundingClientRect()
    app.resizeCanvas(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)))
  }
  resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(wrapper)
  resize()

  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', onPointerUp)
  canvas.addEventListener('wheel', onWheel, { passive: false })

  const urls = props.src
  const transforms = props.transforms
  const dataRotations = props.dataRotations
  const colors = props.colors
  const ids = props.ids

  const kindForIndex = urls.map(kindForUrl)
  const urlToAsset = new Map<string, any>()
  const uniqueAssets: any[] = []

  const assetForIndex = urls.map((url, i) => {
    const kind = kindForIndex[i]
    const needsExclusive = !!colors[i] && kind === 'gsplat'
    if (!needsExclusive) {
      const existing = urlToAsset.get(url)
      if (existing) return existing
    }
    const assetUrl = needsExclusive ? `${url}${url.includes('?') ? '&' : '?'}cmp=${encodeURIComponent(ids[i] ?? String(i))}` : url
    const asset = new pc.Asset(`cmp-${uniqueAssets.length}`, kind === 'mesh' ? 'container' : 'gsplat', { url: assetUrl })
    if (!needsExclusive) urlToAsset.set(url, asset)
    uniqueAssets.push(asset)
    return asset
  })

  await new Promise<void>((resolve, reject) => {
    const loader = new pc.AssetListLoader(uniqueAssets, app.assets)
    loader.load((err: unknown) => (err ? reject(err) : resolve()))
  })
  if (!isActive) return

  for (let i = 0; i < urls.length; i++) {
    const asset = assetForIndex[i]
    const kind = kindForIndex[i]
    const root = new pc.Entity(`CmpRoot-${i}`)
    const t = transforms[i]
    if (t) {
      root.setLocalPosition(t.position[0], t.position[1], t.position[2])
      root.setLocalEulerAngles(t.rotation[0], t.rotation[1], t.rotation[2])
      root.setLocalScale(t.scale[0], t.scale[1], t.scale[2])
    }
    app.root.addChild(root)

    const splat = new pc.Entity(`CmpSplat-${i}`)
    const dr = dataRotations[i] ?? (kind === 'mesh' ? [0, 0, 0] : [180, 0, 0])
    splat.setLocalEulerAngles(dr[0], dr[1], dr[2])
    if (kind === 'mesh') {
      splat.addChild(asset.resource.instantiateRenderEntity())
    } else {
      splat.addComponent('gsplat', { asset })
    }
    root.addChild(splat)
    entityList.push({ root, splat, kind })

    const color = colors[i]
    if (color) applyColorTint(pc, splat, kind, color)
  }

  loading.value = false
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  if (!isActive) return
  if (props.initialCamera) {
    initFromCamera(props.initialCamera)
  } else {
    frameAll()
  }
})

onBeforeUnmount(() => {
  isActive = false
  resizeObserver?.disconnect()
  resizeObserver = null
  if (ownCanvas) {
    ownCanvas.removeEventListener('pointerdown', onPointerDown)
    ownCanvas.removeEventListener('pointermove', onPointerMove)
    ownCanvas.removeEventListener('pointerup', onPointerUp)
    ownCanvas.removeEventListener('wheel', onWheel)
    ownCanvas.remove()
  }
  for (const { root } of entityList) root.destroy()
  entityList = []
})
</script>

<template>
  <div ref="wrapperRef" class="compare-viewer">
    <div v-if="loading" class="compare-viewer__loading">載入中…</div>
  </div>
</template>

<style scoped>
.compare-viewer {
  position: relative;
  width: 100%;
  height: 100%;
}

.compare-viewer :deep(canvas) {
  display: block;
  width: 100%;
  height: 100%;
}

.compare-viewer__loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 0.9rem;
  background: rgba(0, 0, 0, 0.4);
  pointer-events: none;
}
</style>
