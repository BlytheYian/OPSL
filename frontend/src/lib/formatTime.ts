export function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime()
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour

  if (diffMs < minute) return '剛剛'
  if (diffMs < hour) return `${Math.floor(diffMs / minute)} 分鐘前`
  if (diffMs < day) return `${Math.floor(diffMs / hour)} 小時前`
  if (diffMs < 30 * day) return `${Math.floor(diffMs / day)} 天前`
  return date.toLocaleDateString('zh-TW', { year: 'numeric', month: 'short', day: 'numeric' })
}
