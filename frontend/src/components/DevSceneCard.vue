<script lang="ts">
import { ref } from 'vue'
export const DEV_SCENE_ID = 'dev-australia'
export const devSceneActive = ref(false)
export function activateDevScene() { devSceneActive.value = true }
export function deactivateDevScene() { devSceneActive.value = false }
</script>
