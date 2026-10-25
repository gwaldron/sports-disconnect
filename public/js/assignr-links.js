// Links into Assignr's website. Assignr doesn't document its web URLs, so the
// day link is a configurable template (ASSIGNR_DAY_URL) with these tokens:
//   {date} 2026-10-06    {mdy} 10/6/2026    {text} Oct+6+2026 (what Assignr's own filters use)

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function assignrDayUrl(template, date) {
  const [y, m, d] = date.split('-').map(Number);
  return template
    .replaceAll('{date}', date)
    .replaceAll('{mdy}', `${m}/${d}/${y}`)
    .replaceAll('{text}', `${MONTHS[m - 1]}+${d}+${y}`);
}
