import { defineStore } from 'pinia'
import { api } from '../lib/api'
import { useLibraryStore } from './library'

export type Vec3 = [number, number, number]

export interface SceneObjectInstance {
  id: string
  sceneId: string
  modelId: string
  label: string
  hidden: boolean
  position: Vec3
  rotation: Vec3
  scale: Vec3
  color: string | null
}

interface UpdateInstancePayload {
  label?: string
  hidden?: boolean
  position?: Vec3
  rotation?: Vec3
  scale?: Vec3
  color?: string | null
}

interface EditCommandResult {
  instances: SceneObjectInstance[]
  removedIds: string[]
  added: SceneObjectInstance[]
  intendedPositions: Record<string, [number, number, number]>
  reasoning: string | null
}

interface InstanceSnapshot {
  id: string
  sceneId: string
  modelId: string
  label: string
  hidden: boolean
  position: Vec3
  rotation: Vec3
  scale: Vec3
  color: string | null
}
const TRANSFORM_EPSILON = 1e-4
function vec3Equal(a: Vec3, b: Vec3): boolean {
  return (
    Math.abs(a[0] - b[0]) < TRANSFORM_EPSILON &&
    Math.abs(a[1] - b[1]) < TRANSFORM_EPSILON &&
    Math.abs(a[2] - b[2]) < TRANSFORM_EPSILON
  )
}

function snapshot(i: SceneObjectInstance): InstanceSnapshot {
  return {
    id: i.id,
    sceneId: i.sceneId,
    modelId: i.modelId,
    label: i.label,
    hidden: i.hidden,
    position: [...i.position],
    rotation: [...i.rotation],
    scale: [...i.scale],
    color: i.color,
  }
}

type HistoryEntry =
  | { kind: 'add'; instance: InstanceSnapshot; label: string }
  | { kind: 'remove'; instance: InstanceSnapshot; label: string }
  | { kind: 'update'; before: InstanceSnapshot[]; after: InstanceSnapshot[]; label: string }

export interface HistoryTimelineEntry {
  index: number
  label: string
}

export interface HistoryChange {
  updated: SceneObjectInstance[]
  added: SceneObjectInstance[]
  removedIds: string[]
}

export interface SceneVersion {
  id: number
  versionNumber: number
  createdAt: string
  sourceCommands: string[]
  revertedFromVersionId: number | null
}

export interface RiskAssetSuggestion {
  id: string
  name: string
}

export interface RiskMarker {
  id?: number
  riskType: '門檻' | '家具邊角' | '地面高低差' | '走道障礙'
  bboxMin: Vec3
  bboxMax: Vec3
  suggestedAssets: RiskAssetSuggestion[]
}

export interface RouteDetectionResult {
  floorY: number
  cellSize: number
  freeCells: [number, number][]
  narrowCells: [number, number][]
}

export const useSceneObjectsStore = defineStore('sceneObjects', {
  state: () => ({
    instances: [] as SceneObjectInstance[],
    loadedSceneIds: new Set<string>(),
    undoStack: [] as HistoryEntry[],
    redoStack: [] as HistoryEntry[],
    versionsBySceneId: {} as Record<string, SceneVersion[]>,
    pendingCommandsBySceneId: {} as Record<string, string[]>,
  }),
  getters: {
    instancesForScene: (state) => (sceneId: string): SceneObjectInstance[] =>
      state.instances.filter((i) => i.sceneId === sceneId),
    canUndo: (state) => state.undoStack.length > 0,
    canRedo: (state) => state.redoStack.length > 0,
    historyIndex: (state) => state.undoStack.length,
    historyTimeline: (state): HistoryTimelineEntry[] => {
      const past = state.undoStack.map((e, i) => ({ index: i + 1, label: e.label }))
      const future = [...state.redoStack]
        .reverse()
        .map((e, i) => ({ index: state.undoStack.length + i + 1, label: e.label }))
      return [...past, ...future]
    },
    sceneModelUrls() {
      const library = useLibraryStore()
      return (sceneId: string): string[] => {
        const byId = new Map(library.objects.map((o) => [o.id, o.modelUrl ?? '']))
        return this.instancesForScene(sceneId).map((i) => byId.get(i.modelId) ?? '')
      }
    },
    availableModelsForScene() {
      const library = useLibraryStore()
      return () => library.objects
    },
    snapshotAtIndex: (state) => (sceneId: string, targetIndex: number): InstanceSnapshot[] => {
      const snap = new Map<string, InstanceSnapshot>()
      for (const i of state.instances.filter((i) => i.sceneId === sceneId)) {
        snap.set(i.id, { id: i.id, sceneId: i.sceneId, modelId: i.modelId, label: i.label, hidden: i.hidden, position: [...i.position] as Vec3, rotation: [...i.rotation] as Vec3, scale: [...i.scale] as Vec3, color: i.color })
      }
      const currentIndex = state.undoStack.length
      if (targetIndex <= currentIndex) {
        for (let idx = currentIndex - 1; idx >= targetIndex; idx--) {
          const entry = state.undoStack[idx]
          if (entry.kind === 'add') snap.delete(entry.instance.id)
          else if (entry.kind === 'remove') snap.set(entry.instance.id, { ...entry.instance, position: [...entry.instance.position] as Vec3, rotation: [...entry.instance.rotation] as Vec3, scale: [...entry.instance.scale] as Vec3 })
          else for (const b of entry.before) snap.set(b.id, { ...b, position: [...b.position] as Vec3, rotation: [...b.rotation] as Vec3, scale: [...b.scale] as Vec3 })
        }
      } else {
        const redoEntries = [...state.redoStack].reverse()
        for (let idx = 0; idx < targetIndex - currentIndex; idx++) {
          const entry = redoEntries[idx]
          if (!entry) break
          if (entry.kind === 'add') snap.set(entry.instance.id, { ...entry.instance, position: [...entry.instance.position] as Vec3, rotation: [...entry.instance.rotation] as Vec3, scale: [...entry.instance.scale] as Vec3 })
          else if (entry.kind === 'remove') snap.delete(entry.instance.id)
          else for (const a of entry.after) snap.set(a.id, { ...a, position: [...a.position] as Vec3, rotation: [...a.rotation] as Vec3, scale: [...a.scale] as Vec3 })
        }
      }
      return Array.from(snap.values())
    },
  },
  actions: {
    async fetchInstancesForScene(sceneId: string) {
      const fetched = await api.get<SceneObjectInstance[]>(`/scenes/${encodeURIComponent(sceneId)}/objects`)
      if (fetched.length > 0 || !this.loadedSceneIds.has(sceneId)) {
        this.instances = [...this.instances.filter((i) => i.sceneId !== sceneId), ...fetched]
      }
      this.loadedSceneIds.add(sceneId)
    },
    async addInstance(sceneId: string, modelId: string, label: string): Promise<SceneObjectInstance> {
      const instance = await api.post<SceneObjectInstance>(`/scenes/${encodeURIComponent(sceneId)}/objects`, {
        modelId,
        label,
      })
      this.instances.push(instance)
      this.pushHistory({ kind: 'add', instance: snapshot(instance), label: `新增 ${instance.label}` })
      return instance
    },
    async removeInstance(instanceId: string) {
      const instance = this.instances.find((i) => i.id === instanceId)
      if (!instance) return
      const before = snapshot(instance)
      await api.delete(`/scenes/${encodeURIComponent(instance.sceneId)}/objects/${encodeURIComponent(instanceId)}`)
      this.instances = this.instances.filter((i) => i.id !== instanceId)
      this.pushHistory({ kind: 'remove', instance: before, label: `移除 ${before.label}` })
    },
    async renameInstance(instanceId: string, label: string) {
      await this.patchInstance(instanceId, { label }, `重新命名為「${label}」`)
    },
    async setHidden(instanceId: string, hidden: boolean) {
      await this.patchInstance(instanceId, { hidden }, hidden ? '隱藏物件' : '顯示物件')
    },
    async updateTransform(instanceId: string, transform: { position: Vec3; rotation: Vec3; scale: Vec3 }) {
      const instance = this.instances.find((i) => i.id === instanceId)
      if (!instance) return
      const parts: string[] = []
      if (!vec3Equal(transform.position, instance.position)) parts.push('移動')
      if (!vec3Equal(transform.rotation, instance.rotation)) parts.push('旋轉')
      if (!vec3Equal(transform.scale, instance.scale)) parts.push('縮放')
      const label = parts.length ? parts.join('/') : '調整位置/旋轉/縮放'
      await this.patchInstance(instanceId, transform, label)
    },
    async silentMoveInstance(instanceId: string, position: Vec3) {
      const instance = this.instances.find((i) => i.id === instanceId)
      if (!instance) return
      const updated = await api.patch<SceneObjectInstance>(
        `/scenes/${encodeURIComponent(instance.sceneId)}/objects/${encodeURIComponent(instanceId)}`,
        { position }
      )
      Object.assign(instance, updated)
    },
    async patchInstance(instanceId: string, payload: UpdateInstancePayload, actionLabel: string) {
      const instance = this.instances.find((i) => i.id === instanceId)
      if (!instance) return
      const before = snapshot(instance)
      const updated = await api.patch<SceneObjectInstance>(
        `/scenes/${encodeURIComponent(instance.sceneId)}/objects/${encodeURIComponent(instanceId)}`,
        payload
      )
      Object.assign(instance, updated)
      this.pushHistory({
        kind: 'update',
        before: [before],
        after: [snapshot(instance)],
        label: `${actionLabel}：${before.label}`,
      })
    },
    async submitEditCommand(
      sceneId: string,
      command: string,
      image: string,
      instances: { id: string; label: string; x: number; y: number }[],
      previousContext: { command: string; instances: { id: string; label: string }[] } | null,
      cameraAxes: { right: Vec3; up: Vec3; forward: Vec3 } | null
    ): Promise<EditCommandResult> {
      const result = await api.post<EditCommandResult>(`/scenes/${encodeURIComponent(sceneId)}/edit-commands`, {
        command,
        image,
        instances,
        previousContext,
        cameraAxes,
      })
      const before: InstanceSnapshot[] = []
      const after: InstanceSnapshot[] = []
      for (const updated of result.instances) {
        const instance = this.instances.find((i) => i.id === updated.id)
        if (instance) {
          before.push(snapshot(instance))
          Object.assign(instance, updated)
          after.push(snapshot(instance))
        }
      }
      if (before.length) this.pushHistory({ kind: 'update', before, after, label: command })

      for (const removedId of result.removedIds) {
        const instance = this.instances.find((i) => i.id === removedId)
        if (!instance) continue
        const removedSnapshot = snapshot(instance)
        this.instances = this.instances.filter((i) => i.id !== removedId)
        this.pushHistory({ kind: 'remove', instance: removedSnapshot, label: command })
      }

      for (const addedInstance of result.added) {
        this.instances.push(addedInstance)
        this.pushHistory({ kind: 'add', instance: snapshot(addedInstance), label: command })
      }

      return result
    },

    pushHistory(entry: HistoryEntry) {
      this.undoStack.push(entry)
      this.redoStack = []
      const sceneId = entry.kind === 'update' ? entry.before[0]?.sceneId : entry.instance.sceneId
      if (sceneId) {
        this.pendingCommandsBySceneId[sceneId] = [...(this.pendingCommandsBySceneId[sceneId] ?? []), entry.label]
      }
    },
    async deleteRaw(instanceId: string) {
      const instance = this.instances.find((i) => i.id === instanceId)
      if (!instance) return
      await api.delete(`/scenes/${encodeURIComponent(instance.sceneId)}/objects/${encodeURIComponent(instanceId)}`)
      this.instances = this.instances.filter((i) => i.id !== instanceId)
    },
    async createRaw(snap: InstanceSnapshot): Promise<SceneObjectInstance> {
      const instance = await api.post<SceneObjectInstance>(`/scenes/${encodeURIComponent(snap.sceneId)}/objects`, {
        modelId: snap.modelId,
        label: snap.label,
      })
      this.instances.push(instance)
      const updated = await api.patch<SceneObjectInstance>(
        `/scenes/${encodeURIComponent(snap.sceneId)}/objects/${encodeURIComponent(instance.id)}`,
        {
          hidden: snap.hidden,
          position: snap.position,
          rotation: snap.rotation,
          scale: snap.scale,
          color: snap.color,
        }
      )
      Object.assign(instance, updated)
      return instance
    },
    async applyHistoryEntry(entry: HistoryEntry, direction: 'undo' | 'redo'): Promise<HistoryChange> {
      if (entry.kind === 'add') {
        if (direction === 'undo') {
          await this.deleteRaw(entry.instance.id)
          return { updated: [], added: [], removedIds: [entry.instance.id] }
        }
        const restored = await this.createRaw(entry.instance)
        entry.instance = snapshot(restored)
        return { updated: [], added: [restored], removedIds: [] }
      }
      if (entry.kind === 'remove') {
        if (direction === 'undo') {
          const restored = await this.createRaw(entry.instance)
          entry.instance = snapshot(restored)
          return { updated: [], added: [restored], removedIds: [] }
        }
        await this.deleteRaw(entry.instance.id)
        return { updated: [], added: [], removedIds: [entry.instance.id] }
      }
      // kind === 'update'
      const target = direction === 'undo' ? entry.before : entry.after
      const updated: SceneObjectInstance[] = []
      for (const snap of target) {
        const instance = this.instances.find((i) => i.id === snap.id)
        if (!instance) continue
        const result = await api.patch<SceneObjectInstance>(
          `/scenes/${encodeURIComponent(snap.sceneId)}/objects/${encodeURIComponent(snap.id)}`,
          {
            label: snap.label,
            hidden: snap.hidden,
            position: snap.position,
            rotation: snap.rotation,
            scale: snap.scale,
            color: snap.color,
          }
        )
        Object.assign(instance, result)
        updated.push(instance)
      }
      return { updated, added: [], removedIds: [] }
    },
    /** Ctrl+Z——復原最近一筆動作。 */
    async undo(): Promise<HistoryChange | null> {
      const entry = this.undoStack.pop()
      if (!entry) return null
      const change = await this.applyHistoryEntry(entry, 'undo')
      this.redoStack.push(entry)
      return change
    },
    /** Ctrl+Y / Ctrl+Shift+Z——取消復原,重新套用被 undo 掉的那筆動作。 */
    async redo(): Promise<HistoryChange | null> {
      const entry = this.redoStack.pop()
      if (!entry) return null
      const change = await this.applyHistoryEntry(entry, 'redo')
      this.undoStack.push(entry)
      return change
    },
    async jumpToIndex(sceneId: string, targetIndex: number): Promise<HistoryChange> {
      const before = this.instancesForScene(sceneId)
      while (this.undoStack.length > targetIndex) {
        const entry = this.undoStack.pop()
        if (!entry) break
        await this.applyHistoryEntry(entry, 'undo')
        this.redoStack.push(entry)
      }
      while (this.undoStack.length < targetIndex) {
        const entry = this.redoStack.pop()
        if (!entry) break
        await this.applyHistoryEntry(entry, 'redo')
        this.undoStack.push(entry)
      }
      const after = this.instancesForScene(sceneId)
      const afterIds = new Set(after.map((i) => i.id))
      const beforeIds = new Set(before.map((i) => i.id))
      return {
        removedIds: before.filter((i) => !afterIds.has(i.id)).map((i) => i.id),
        added: after.filter((i) => !beforeIds.has(i.id)),
        updated: after.filter((i) => beforeIds.has(i.id)),
      }
    },
    clearHistory(sceneId?: string) {
      this.undoStack = []
      this.redoStack = []
      if (sceneId) delete this.pendingCommandsBySceneId[sceneId]
    },

    async fetchVersionInstances(sceneId: string, versionId: number): Promise<InstanceSnapshot[]> {
      return api.get<InstanceSnapshot[]>(`/scenes/${encodeURIComponent(sceneId)}/versions/${versionId}/instances`)
    },
    async fetchVersions(sceneId: string) {
      const versions = await api.get<SceneVersion[]>(`/scenes/${encodeURIComponent(sceneId)}/versions`)
      this.versionsBySceneId[sceneId] = versions
    },
    async fetchRisks(sceneId: string, versionId: number): Promise<RiskMarker[]> {
      return api.get<RiskMarker[]>(
        `/scenes/${encodeURIComponent(sceneId)}/versions/${versionId}/risks`
      )
    },
    async checkRisksNow(sceneId: string): Promise<RiskMarker[]> {
      return api.post<RiskMarker[]>(`/scenes/${encodeURIComponent(sceneId)}/risk-check`, {})
    },
    async fetchFloorDetection(
      sceneId: string
    ): Promise<{ y: number; cellSize: number; cells: [number, number][] } | null> {
      const result = await api.get<{ bounds: { y: number; cellSize: number; cells: [number, number][] } | null }>(
        `/scenes/${encodeURIComponent(sceneId)}/floor-detection`
      )
      return result.bounds
    },
    async detectRoute(sceneId: string): Promise<RouteDetectionResult | null> {
      return api.post<RouteDetectionResult | null>(
        `/scenes/${encodeURIComponent(sceneId)}/route-detection`,
        {}
      )
    },
    async createVersion(sceneId: string) {
      const version = await api.post<SceneVersion>(`/scenes/${encodeURIComponent(sceneId)}/versions`, {
        sourceCommands: [],
      })
      this.versionsBySceneId[sceneId] = [version, ...(this.versionsBySceneId[sceneId] ?? [])]
      return version
    },
    async patchVersionCommands(sceneId: string, versionId: number, sourceCommands: string[]) {
      await api.patch(
        `/scenes/${encodeURIComponent(sceneId)}/versions/${versionId}/commands`,
        { sourceCommands }
      )
      const list = this.versionsBySceneId[sceneId]
      if (list) {
        const v = list.find((v) => v.id === versionId)
        if (v) v.sourceCommands = sourceCommands
      }
    },
    async deleteVersion(sceneId: string, versionId: number) {
      await api.delete(`/scenes/${encodeURIComponent(sceneId)}/versions/${versionId}`)
      const list = this.versionsBySceneId[sceneId]
      if (list) this.versionsBySceneId[sceneId] = list.filter((v) => v.id !== versionId)
    },
    async restoreVersion(sceneId: string, versionId: number): Promise<HistoryChange> {
      const before = this.instancesForScene(sceneId)
      const result = await api.post<{ instances: SceneObjectInstance[]; newVersion: SceneVersion }>(
        `/scenes/${encodeURIComponent(sceneId)}/versions/${versionId}/restore`,
        {}
      )
      const afterIds = new Set(result.instances.map((i) => i.id))
      const beforeIds = new Set(before.map((i) => i.id))
      this.instances = [...this.instances.filter((i) => i.sceneId !== sceneId), ...result.instances]
      this.versionsBySceneId[sceneId] = [result.newVersion, ...(this.versionsBySceneId[sceneId] ?? [])]
      return {
        removedIds: before.filter((i) => !afterIds.has(i.id)).map((i) => i.id),
        added: result.instances.filter((i) => !beforeIds.has(i.id)),
        updated: result.instances.filter((i) => beforeIds.has(i.id)),
      }
    },
  },
})
