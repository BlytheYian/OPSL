import { defineStore } from 'pinia'
import { api, API_ORIGIN, ApiError } from '../lib/api'

export interface LibraryItem {
  id: string
  name: string
  thumbnail: string
  createdAt: Date
  status: 'ready' | 'generating'
  description: string
  modelUrl?: string
}

interface LibraryItemDTO {
  id: string
  name: string
  thumbnail: string
  createdAt: string
  status: 'ready' | 'generating'
  description: string
  modelUrl?: string
}

function fromDTO(dto: LibraryItemDTO): LibraryItem {
  return { ...dto, createdAt: new Date(dto.createdAt) }
}

export type Vec3 = [number, number, number]

export const PLACEHOLDER_THUMBNAIL = '/hero-living-room.jpg'

export function upAxisFixFor(modelId: string, modelUrl?: string): Vec3 {
  if (modelUrl?.toLowerCase().endsWith('.glb')) return [0, 0, 0]
  if (modelId.includes('interiorgs839920-')) return [-90, 0, 0]
  return [180, 0, 0]
}

export const useLibraryStore = defineStore('library', {
  state: () => ({
    scenes: [] as LibraryItem[],
    objects: [] as LibraryItem[],
    catalogScenes: [] as LibraryItem[],
    catalogObjects: [] as LibraryItem[],
    scenesLoaded: false,
    objectsLoaded: false,
    catalogScenesLoaded: false,
    catalogObjectsLoaded: false,
    objectSizes: {} as Record<string, [number, number, number]>,
  }),
  actions: {
    async fetchScenes() {
      const dtos = await api.get<LibraryItemDTO[]>('/library/scenes')
      this.scenes = dtos.map(fromDTO)
      this.scenesLoaded = true
    },
    async fetchObjects() {
      const dtos = await api.get<LibraryItemDTO[]>('/library/objects')
      this.objects = dtos.map(fromDTO)
      this.objectsLoaded = true
    },
    async fetchCatalogScenes() {
      const dtos = await api.get<LibraryItemDTO[]>('/library/scenes?scope=all')
      this.catalogScenes = dtos.map(fromDTO)
      this.catalogScenesLoaded = true
    },
    async fetchCatalogObjects() {
      const dtos = await api.get<LibraryItemDTO[]>('/library/objects?scope=all')
      this.catalogObjects = dtos.map(fromDTO)
      this.catalogObjectsLoaded = true
    },
    async copySceneToMyLibrary(id: string): Promise<LibraryItem> {
      const dto = await api.post<LibraryItemDTO>(`/library/scenes/${encodeURIComponent(id)}/copy`)
      const item = fromDTO(dto)
      this.scenes.push(item)
      return item
    },
    async copyObjectToMyLibrary(id: string): Promise<LibraryItem> {
      const dto = await api.post<LibraryItemDTO>(`/library/objects/${encodeURIComponent(id)}/copy`)
      const item = fromDTO(dto)
      this.objects.push(item)
      return item
    },
    async renameScene(id: string, name: string): Promise<void> {
      const dto = await api.patch<LibraryItemDTO>(`/library/scenes/${encodeURIComponent(id)}`, { name })
      const item = fromDTO(dto)
      for (const list of [this.scenes, this.catalogScenes]) {
        const existing = list.find((s) => s.id === id)
        if (existing) Object.assign(existing, item)
      }
    },
    async renameObject(id: string, name: string): Promise<void> {
      const dto = await api.patch<LibraryItemDTO>(`/library/objects/${encodeURIComponent(id)}`, { name })
      const item = fromDTO(dto)
      for (const list of [this.objects, this.catalogObjects]) {
        const existing = list.find((o) => o.id === id)
        if (existing) Object.assign(existing, item)
      }
    },
    async saveThumbnail(kind: 'scene' | 'object', id: string, blob: Blob): Promise<void> {
      const form = new FormData()
      form.append('thumbnail', blob, `${id}.jpg`)
      const res = await fetch(`${API_ORIGIN}/api/v1/library/${kind}s/${encodeURIComponent(id)}/thumbnail`, {
        method: 'POST',
        credentials: 'include',
        body: form,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const { thumbnailUrl } = (await res.json()) as { thumbnailUrl: string }
      const lists = kind === 'scene' ? [this.scenes, this.catalogScenes] : [this.objects, this.catalogObjects]
      for (const list of lists) {
        const existing = list.find((x) => x.id === id)
        if (existing) existing.thumbnail = thumbnailUrl
      }
    },
    async uploadObject(file: File, name?: string): Promise<LibraryItem> {
      const form = new FormData()
      form.append('model', file)
      if (name) form.append('name', name)
      const res = await fetch(`${API_ORIGIN}/api/v1/library/objects`, {
        method: 'POST',
        credentials: 'include',
        body: form,
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new ApiError(res.status, body.error || `上傳失敗(${res.status})`)
      }
      const item = fromDTO(await res.json())
      this.objects.push(item)
      return item
    },
  },
})
