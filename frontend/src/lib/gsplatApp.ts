// 全 App 共用單一 PlayCanvas Application 實例,不要每次開預覽彈窗/編輯器頁面就建立並銷毀一整個 Application。
// 原因:反覆建立/銷毀 Application(各自綁一個 WebGL context)會導致腳本註冊等內部狀態跨實例污染,
// 實測會讓第二個 Application 的畫面整個變黑(無錯誤訊息),改成單例可以直接避開這整類問題。
// canvas 元素在不同用途(彈窗/編輯器)間用 DOM reparent 搬移。
//
// 相機也只建立這一次、整個 App 生命週期共用,不要每次掛載都新建、卸載時銷毀:
// PlayCanvas 的 LOD 串流管理器(GSplatDirector)內部有個 camerasMap,遇到新相機就記一筆,
// 相機被銷毀時完全不會從 map 裡移除——場景切換幾次後,map 裡會堆積好幾個「已銷毀」的舊相機,
// 每一幀 GSplatDirector.updateStreaming() 還是會拿它們出來用,存取已經被移除的 camera 元件就會拋出
// 「Cannot read properties of undefined (reading 'fov')」這類例外。相機重複使用同一個實體就不會累積。
export type GizmoMode = 'translate' | 'rotate' | 'scale'
export type Gizmos = Record<GizmoMode, any>

let appPromise: Promise<{
  pc: any
  app: any
  canvas: HTMLCanvasElement
  /** 編輯頁面(SceneEditPage.vue)專用的相機——手柄、多物件選取狀態都綁在這顆上面。 */
  editorCamera: any
  /** 預覽類(PreviewModal.vue/ThumbnailBackfill.vue/UploadModal.vue 截圖用)共用的相機——
   * 這三個情境都只顯示單一模型、不需要手柄,彼此之間也不會巢狀疊起來(同時間只會有一個預覽
   * 開著),共用一顆就夠,不用每個 instance 各自一顆。
   *
   * 為什麼要跟編輯頁面分開,不繼續共用同一顆:預覽/縮圖截圖需要把相機移到框住模型的位置,
   * 编輯頁面則需要相機維持使用者自己操作的視角——共用同一顆的話,不管開/關預覽或截圖的時機
   * 多注意,都會有「這次忘記把相機搬回去」的漏洞(這個晚上已經連續踩到兩次:縮圖截圖忘記復原、
   * 預覽模式忘記復原,連累到編輯頁面的手柄縮放跟著算錯)。分成两顆相機,結構上就不可能互相
   * 影響,不用再靠人工記得「這裡也要補一次復原」。
   */
  previewCamera: any
  gizmos: Gizmos
  highlightLines: any[]
}> | null = null

export function getSharedGSplatApp() {
  if (!appPromise) {
    appPromise = (async () => {
      const playcanvasUrl = `${window.location.origin}/scripts/playcanvas.mjs`
      const pc = await import(/* @vite-ignore */ playcanvasUrl)
      const canvas = document.createElement('canvas')
      const app = new pc.Application(canvas, {
        // preserveDrawingBuffer:縮圖截圖(PreviewModal.vue/ThumbnailBackfill.vue → GSplatViewer.captureThumbnail())
        // 要在 render 完之後的下一個 tick 才呼叫 canvas.toBlob() 讀回畫面內容——WebGL canvas 預設
        // render 完、瀏覽器合成畫面後就可能清空 drawing buffer,不開這個選項的話 toBlob 抓到的
        // 常常是空白/黑畫面。代價是每幀多一點記憶體頻寬,這個 app 場景不大,可接受。
        graphicsDeviceOptions: { antialias: false, preserveDrawingBuffer: true },
      })
      app.setCanvasFillMode(pc.FILLMODE_NONE)
      app.setCanvasResolution(pc.RESOLUTION_AUTO)
      app.start()

      const scriptAsset = new pc.Asset('camera-controls', 'script', { url: '/scripts/camera-controls.mjs' })
      const loader = new pc.AssetListLoader([scriptAsset], app.assets)
      await new Promise<void>((resolve, reject) => {
        loader.load((err: unknown) => (err ? reject(err) : resolve()))
      })

      // 編輯頁面跟預覽類各自一顆獨立相機,見上面 appPromise 型別裡 previewCamera 的說明——
      // 各自有自己的 camera 元件跟 cameraControls script instance(拖曳/縮放視角互不影響)。
      // 同一時間只有其中一顆該 enabled(claimCanvas/releaseCanvas 負責切換),另一顆停用。
      const editorCamera = new pc.Entity('EditorCamera')
      editorCamera.setPosition(0, 0, 3)
      editorCamera.addComponent('camera')
      editorCamera.addComponent('script')
      editorCamera.script.create('cameraControls')
      app.root.addChild(editorCamera)

      const previewCamera = new pc.Entity('PreviewCamera')
      previewCamera.setPosition(0, 0, 3)
      previewCamera.addComponent('camera')
      previewCamera.addComponent('script')
      previewCamera.script.create('cameraControls')
      previewCamera.enabled = false
      app.root.addChild(previewCamera)

      // Gaussian splat 是不需要場景光源的(每顆高斯自己的球諧係數就烘進了輻射度資訊,走的是完全
      // 獨立、不受一般光照影響的渲染路徑)——這個 app 一直以來只渲染 gsplat,從沒加過任何光源。
      // 但 .glb 這種一般網格(見 GSplatViewer.vue 的 kindForUrl()/mesh 渲染路徑)用的是標準
      // PBR 材質,場景沒有任何光源的話材質幾乎是全黑、看起來就像「沒有貼圖」——不是貼圖真的沒載入,
      // 是完全沒有光可以反射。補一顆方向光(模擬太陽,固定角度,使用者用滑鼠拖曳鏡頭繞著看,角度
      // 本來就會一直變,不需要跟著相機動)+ 稍微調亮環境光(避免背光面死黑),對既有的 gsplat 完全
      // 沒影響——gsplat 的渲染路徑不吃這些設定。
      const sun = new pc.Entity('Sun')
      sun.addComponent('light', { type: 'directional', intensity: 1.2 })
      sun.setEulerAngles(45, 30, 0)
      app.root.addChild(sun)
      app.scene.ambientLight = new pc.Color(0.35, 0.35, 0.35)

      // Blender 風格的移動/旋轉/縮放手柄(TranslateGizmo/RotateGizmo/ScaleGizmo),
      // 引擎本身就有,只是原始碼放在 npm 套件的 extras/ 底下、指向套件內部路徑的 import,
      // 沒辦法直接用瀏覽器原生 import 載入——已手動搬進 public/scripts/gizmo/ 並把那些
      // import 改成指向這份共用的 playcanvas.mjs,邏輯本身沒有更動。
      // 三個手柄只給編輯頁面用,綁定編輯頁面專用的那顆相機——一次建好、全生命週期共用,
      // 切換模式時只是 attach/detach 到不同的手柄,不用重新建立。
      const gizmoUrl = `${window.location.origin}/scripts/gizmo/index.js`
      const gizmoModule = await import(/* @vite-ignore */ gizmoUrl)
      const gizmoLayer = gizmoModule.Gizmo.createLayer(app)
      const gizmos: Gizmos = {
        translate: new gizmoModule.TranslateGizmo(editorCamera.camera, gizmoLayer),
        rotate: new gizmoModule.RotateGizmo(editorCamera.camera, gizmoLayer),
        scale: new gizmoModule.ScaleGizmo(editorCamera.camera, gizmoLayer),
      }

      // Gizmo 自己在 canvas 上掛的 pointerdown/pointermove/pointerup 監聽器,
      // 跟 camera-controls 腳本底層(KeyboardMouseSource)掛在同一個 canvas 上的監聽器是各自獨立的——
      // Gizmo 內部雖然有呼叫 e.stopPropagation(),但那只會擋事件往上傳到父層元素,並不會擋掉
      // 掛在「同一個」canvas 元素上的其他監聽器,所以拖曳手柄的同時,鏡頭控制腳本還是會照樣把
      // 同一串滑鼠移動當成軌道旋轉/平移來處理,造成「拖手柄,場景也在轉」。
      // 解法:只在真的抓到手柄(selection 有值,不是隨便點在空白處)時,暫時關掉鏡頭控制腳本,
      // 放開滑鼠再打開,兩者互不干擾。手柄只會出現在編輯頁面,只需要管編輯頁面那顆相機的
      // cameraControls。
      const cameraControls = editorCamera.script.cameraControls
      for (const gizmo of Object.values(gizmos)) {
        gizmo.on('pointer:down', (_x: number, _y: number, selection: unknown) => {
          if (selection) cameraControls.enabled = false
        })
        gizmo.on('pointer:up', () => {
          cameraControls.enabled = true
        })
      }

      // 選取物件的外框提示:試過 app.drawWireAlignedBox/drawLines(引擎內建的 immediate-mode
      // 除錯畫線 API),結果完全不會顯示——GSplat 用自己的一套合成/排序 pass 畫面,不會跟一般
      // layer 裡的 immediate-mode 畫線合成,不管畫在哪個 layer 都一樣蓋不過去。手柄本身卻能正常疊在
      // 高斯上面,因為手柄是「真的 mesh entity」,跟 GSplat 用同一套一般的 mesh 渲染路徑,不是
      // immediate-mode。所以外框也比照辦理:直接借用 gizmo 模組自己內部畫手柄用的 MeshLine
      // (用一根圓柱體貼合旋轉縮放來模擬線段),建 12 條當外框的 12 個邊,跟手柄共用同一個 layer。
      // thickness 是世界座標單位,不是螢幕像素,預設 0.02 在這種場景尺度(常常上百單位)下
      // 細到不到一個像素,實際上完全看不見——手柄自己的線是靠 Gizmo._updateScale() 依相機距離
      // 動態換算成固定螢幕大小,外框沒有那套機制,只能給一個相對場景尺度合理的固定粗細。
      const highlightLines = Array.from({ length: 12 }, () => new gizmoModule.MeshLine(app, gizmoLayer, { thickness: 0.4 }))
      for (const line of highlightLines) {
        app.root.addChild(line.entity)
        line.entity.enabled = false
      }

      return { pc, app, canvas, editorCamera, previewCamera, gizmos, highlightLines }
    })()
  }
  return appPromise
}

/** 一個 GSplatViewer 掛載期間「擁有」的東西:自己建立的 entity、掛載時要用的 DOM 容器,
 * 還有拿回畫布控制權時要重新套用手柄/外框狀態用的 callback。用來支援「編輯頁面的主畫面還在、
 * 預覽彈窗疊在上面同時出現」這種巢狀情境——以前只有單一 activeSession 的假設(彈窗開,編輯頁面
 * 的東西整個被銷毀;彈窗關,畫布直接從畫面消失,編輯頁面變黑)在這種巢狀情境下就不成立了。
 *
 * 隱藏/顯示一個 session 的所有 entity 用的是 entity.enabled 逐一切換(不是把 gsplat 放到專屬
 * layer、切換 camera.layers)——曾經試過 layer 版本以避免整場景重新合成的成本,結果實測發現
 * PlayCanvas 的 GSplatComponentSystem 只要偵測到某個 layer 離開 camera 目前渲染的 layer 清單
 * (不管是被移出 camera.layers 還是 layer.enabled=false),就會直接銷毀那個 (camera, layer)
 * 組合快取的 GSplatManager/WorldState,layer 重新回到 camera 的清單時,只有在 placement 集合
 * 真的有變動(gsplatPlacementsDirty)才會重建——但我們的情境是 placement 集合從頭到尾沒變過
 * (只是想暫時不渲染),所以重建永遠不會被觸發,那個 layer 從此變成永久空白畫面。換句話說:
 * 「離開 camera 的渲染清單」本身就等同「銷毀渲染狀態」,不存在真正廉價的暫停/恢復機制——
 * 不管用 entity.enabled 還是 layer 切換,重新顯示已載入的整個場景都無法避免一次完整重算
 * (成本正比於該場景目前的總高斯數)。因此改用更簡單、至少正確的 entity.enabled 逐一切換,
 * 效能問題改用 UX 層面處理(見 SceneEditPage.vue/PreviewModal.vue 的處理中提示)。 */
export type ViewerSession = {
  wrapper: HTMLElement
  entities: Set<any>
  /** 這個 session 用哪顆相機(editorCamera 或 previewCamera,見 getSharedGSplatApp() 的說明)——
   * claimCanvas/releaseCanvas 切換 session 時,要跟著切換哪顆相機是 enabled 的,不然編輯頁面跟
   * 預覽同時掛載時,兩顆相機都在 enabled 狀態,會互相干擾/浪費資源。 */
  camera: any
  /** 目前是不是排在最上面、真正顯示中的那個 session——GSplatViewer 每一幀的 onAppUpdate
   * (手柄定位、畫外框)要檢查這個,不是自己的 session 就什麼都不做,不然多個 GSplatViewer
   * 同時掛載時,大家的 onAppUpdate 每一幀都在搶著控制同一組共用的手柄/外框物件。 */
  active: boolean
  /** 這個 session 重新拿回畫布控制權時呼叫,讓它有機會重新套用自己的手柄/外框狀態
   * (claimCanvas/releaseCanvas 只會主動關掉手柄,不會主動幫某個 session 打開它自己要的手柄) */
  reapply?: () => void
  /** 這個 session 重新拿回畫布控制權時呼叫,用自己容器「目前」的實際尺寸重新設定畫布的渲染解析度。
   * 畫布借給另一個 session(例如彈窗)期間,對方會把畫布內部解析度改成它自己容器的尺寸/長寬比;
   * 畫布還回來時,這個 session 自己的容器尺寸通常根本沒變,ResizeObserver 不會因此觸發,
   * 不主動呼叫一次的話,畫布就會用著別人容器的解析度/長寬比硬套用在這個容器上,畫面跟著變形錯位。 */
  resize?: () => void
}

const sessionStack: ViewerSession[] = []

/** 這個 GSplatViewer 掛載時呼叫:把畫布搬進自己的容器,同時暫時隱藏(不是銷毀!)目前排在上面
 * 那個 session 的所有 entity,並把手柄收起來,避免兩邊的高斯/手柄同時疊在畫面上。 */
export function claimCanvas(canvas: HTMLCanvasElement, session: ViewerSession, gizmos?: Gizmos) {
  const current = sessionStack[sessionStack.length - 1]
  if (current && current !== session) {
    current.active = false
    for (const e of current.entities) e.enabled = false
    if (current.camera !== session.camera) current.camera.enabled = false
  }
  if (gizmos) {
    for (const gizmo of Object.values(gizmos)) gizmo.detach()
  }
  const idx = sessionStack.indexOf(session)
  if (idx !== -1) sessionStack.splice(idx, 1)
  sessionStack.push(session)
  session.active = true
  session.camera.enabled = true
  for (const e of session.entities) e.enabled = true
  session.wrapper.appendChild(canvas)
  session.resize?.()
  session.reapply?.()
}

/** 這個 GSplatViewer 卸載時呼叫:銷毀「自己建立的」entity(這個 viewer 真的不會再用到了),
 * 並把畫布交還給排在它底下、還在畫面上的上一個 session(如果有的話),重新顯示那個 session
 * 原本就存在、剛剛被暫時隱藏的 entity,並呼叫它的 reapply 讓它自己重新套用手柄狀態。
 *
 * 注意:重新啟用一個已載入大量高斯的 session(例如編輯頁面的完整場景)時,PlayCanvas 需要
 * 整層重新合成/排序/上傳 GPU 緩衝區,成本正比於該 session 目前的總高斯數,對於幾百萬顆高斯的
 * 場景可能要花上數秒、且是同步阻塞主執行緒——呼叫端(關閉巢狀預覽彈窗的地方)要自己先顯示
 * 「處理中」提示再呼叫這個函式,不然使用者會覺得畫面卡死。 */
export function releaseCanvas(canvas: HTMLCanvasElement, session: ViewerSession, gizmos?: Gizmos): ViewerSession | null {
  session.active = false
  const idx = sessionStack.indexOf(session)
  if (idx !== -1) sessionStack.splice(idx, 1)
  for (const e of session.entities) e.destroy()
  session.entities.clear()

  const previous = sessionStack[sessionStack.length - 1]
  if (previous && previous.wrapper.isConnected) {
    if (previous.camera !== session.camera) session.camera.enabled = false
    previous.active = true
    previous.camera.enabled = true
    for (const e of previous.entities) e.enabled = true
    previous.wrapper.appendChild(canvas)
    previous.resize?.()
    previous.reapply?.()
    return previous
  }
  session.camera.enabled = false
  if (gizmos) {
    for (const gizmo of Object.values(gizmos)) gizmo.detach()
  }
  canvas.remove()
  return null
}

/** 切換啟用中的手柄模式(或傳 null 完全不顯示),並把它附加到指定的物件 Entity 上。
 * 同一時間只有一個手柄啟用,避免三種手柄疊在一起顯示。 */
export function setGizmoTarget(gizmos: Gizmos, mode: GizmoMode | null, entity: any | null) {
  // entity 是 null(取消選取、或選取的物件被移除了)時,連目前這個 mode 自己的手柄也要收起來——
  // 不能只收「其他模式」的手柄,不然手柄會停留在附著到一個已經不存在/沒被選取的 entity 上,
  // 畫面上留著一個沒人選取的殘影手柄(拖它甚至可能因為 entity 已被銷毀而出錯)。
  for (const key of Object.keys(gizmos) as GizmoMode[]) {
    if (key !== mode || !entity) gizmos[key].detach()
  }
  if (mode && entity) {
    gizmos[mode].attach([entity])
  }
}
