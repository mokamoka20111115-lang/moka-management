// 年月だけを扱い、現地時刻とUTCの変換による月のずれを避ける。
export function moveMonth(month, direction) {
  const [year, monthNumber] = month.split('-').map(Number)
  const monthIndex = year * 12 + monthNumber - 1 + direction
  const nextYear = Math.floor(monthIndex / 12)
  const nextMonth = monthIndex - nextYear * 12 + 1
  return `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}`
}
