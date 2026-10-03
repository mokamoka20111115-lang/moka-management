export const numberFields = ['dineIn','uberOrder','uberPaid','demaeOrder','demaePaid','rocketOrder','rocketPaid','ingredients','supplies']

export const localDate = (date = new Date()) => {
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 10)
}

export const emptyEntry = (date = localDate()) => ({
  date,
  ...Object.fromEntries(numberFields.map((key) => [key, ''])),
})

const num = (value) => Number(value) || 0

export function calculateDay(entry) {
  const sales = num(entry.dineIn) + num(entry.uberOrder) + num(entry.demaeOrder) + num(entry.rocketOrder)
  const paid = num(entry.dineIn) + num(entry.uberPaid) + num(entry.demaePaid) + num(entry.rocketPaid)
  const deliverySales = num(entry.uberOrder) + num(entry.demaeOrder) + num(entry.rocketOrder)
  const deliveryPaid = num(entry.uberPaid) + num(entry.demaePaid) + num(entry.rocketPaid)
  const fees = deliverySales - deliveryPaid
  const costs = num(entry.ingredients) + num(entry.supplies)
  return { sales, paid, deliverySales, fees, feeRate: deliverySales ? fees / deliverySales * 100 : 0, costs, costRate: sales ? costs / sales * 100 : 0, grossProfit: sales - costs - fees }
}

export function calculateMonth(entries) {
  return entries.reduce((total, entry) => {
    const day = calculateDay(entry)
    Object.keys(total).forEach((key) => { total[key] += day[key] || 0 })
    return total
  }, { sales: 0, costs: 0, fees: 0, grossProfit: 0 })
}
