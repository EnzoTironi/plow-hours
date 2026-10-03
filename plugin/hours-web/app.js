const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
let snapshot;
let busy = false;
const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 });
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const headers = ['Day', 'Start', 'Finish', 'Total (Hours)', 'Rate (USD)', 'Project', 'Details (github ticket, git commit, etc)'];

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
function options(id, values, label) {
  const select = $(id);
  const chosen = select.value || params.get(id) || '';
  select.replaceChildren(new Option(label, ''), ...values.map(([value, text]) => new Option(text, value)));
  select.value = values.some(([value]) => value === chosen) ? chosen : '';
}
function view() {
  const people = snapshot.contractors.filter(person => !$('contractor').value || person.id === $('contractor').value);
  const valid = !$('from').value || !$('to').value || $('from').value <= $('to').value;
  const rows = people.flatMap(person => person.entries.map(entry => ({ ...entry, person }))).filter(row => valid
    && (!$('project').value || row.project === $('project').value)
    && (!$('from').value || row.day >= $('from').value) && (!$('to').value || row.day <= $('to').value));
  return { people, valid, closed: rows.filter(row => row.end_ms !== null).sort((a, b) => b.start_ms - a.start_ms || a.id.localeCompare(b.id)), open: rows.filter(row => row.end_ms === null) };
}
function stamp(ms, timezone) {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' }).format(ms);
}
function timeCell(value, day) {
  const cell = element('td', value.slice(11, 19));
  cell.append(element('small', [value.slice(0, 10) !== day ? value.slice(0, 10) : '', value.slice(20)].filter(Boolean).join(' · ')));
  cell.title = value;
  return cell;
}
function render() {
  const { people, valid, closed, open } = view();
  $('total').textContent = number.format(closed.reduce((sum, row) => sum + row.end_ms - row.start_ms, 0) / 3600000);
  $('sessions').textContent = String(closed.length);
  $('working').textContent = String(open.length);
  $('scope').textContent = $('contractor').value ? people[0]?.name || 'Unknown contractor' : `${people.length} contractors · All recorded timezones`;
  $('rows').replaceChildren(...closed.map(row => {
    const tr = element('tr');
    const day = element('td', row.day);
    day.append(element('small', row.person.name));
    const project = element('td');
    project.append(element('span', row.project, 'project-pill'));
    tr.append(day, timeCell(row.start, row.day), timeCell(row.finish, row.day), element('td', number.format((row.end_ms - row.start_ms) / 3600000), 'numeric'), element('td', money.format(row.rate_usd), 'numeric'), project, element('td', row.details, 'detail'));
    return tr;
  }));
  $('open').hidden = open.length === 0;
  $('open').replaceChildren(...open.map(row => {
    const node = element('div', undefined, 'open-clock');
    node.append(element('span', '', 'dot'), element('strong', `${row.person.name} is working`), element('span', `${row.demand_id} · Started ${stamp(row.start_ms, row.timezone)}`), element('small', 'Excluded from recorded total'));
    return node;
  }));
  $('empty').hidden = closed.length > 0;
  $('empty').querySelector('h3').textContent = valid ? (snapshot.contractors.length ? 'No completed sessions in this view' : 'Ready for your first contractor') : 'Check the date range';
  $('empty').querySelector('p').textContent = valid ? (snapshot.contractors.length ? 'Hours appear when a contractor stops their clock. Try clearing the filters.' : 'Register a contractor and their assigned work with the agent to get started.') : 'The end date must be on or after the start date.';
  $('row-count').textContent = `${closed.length} completed ${closed.length === 1 ? 'session' : 'sessions'}`;
  $('download').disabled = !$('contractor').value || !closed.length || !valid;
  $('export-hint').textContent = $('contractor').value ? 'Dates and rates follow each session’s recorded timezone and hourly rate.' : 'Choose a contractor to download their timesheet.';
  $('demands').replaceChildren(...people.flatMap(person => person.demands.filter(demand => !$('project').value || demand.project === $('project').value).map(demand => {
    const node = element('div', undefined, 'demand');
    const title = element('div', undefined, 'demand-title');
    title.append(element('span', demand.project), element('code', demand.id));
    node.append(title, element('p', `${person.name} · ${demand.summary}`));
    if (demand.references) node.append(element('p', demand.references));
    return node;
  })));
  if (!$('demands').childElementCount) $('demands').append(element('p', 'No assigned work in this view.'));
  $('profiles').replaceChildren(...people.map(person => {
    const node = element('div', undefined, 'profile');
    const title = element('div', person.name, 'profile-title');
    title.append(element('span', `${money.format(person.rate_usd)} / hour`));
    node.append(title, element('p', person.timezone));
    return node;
  }));
  const query = new URLSearchParams();
  for (const id of ['contractor', 'project', 'from', 'to']) if ($(id).value) query.set(id, $(id).value);
  history.replaceState(null, '', `${location.pathname}${query.size ? '?' + query : ''}`);
  for (const key of [...params.keys()]) params.delete(key);
}
async function refresh() {
  if (busy) return;
  busy = true;
  $('refresh').disabled = true;
  try {
    const response = await fetch('/hours/data', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('Could not load hours');
    snapshot = await response.json();
    options('contractor', snapshot.contractors.map(person => [person.id, person.name]), 'All contractors');
    options('project', [...new Set(snapshot.contractors.flatMap(person => person.demands.map(demand => demand.project)))].sort().map(project => [project, project]), 'All projects');
    $('notice').hidden = true;
    $('updated').textContent = `Updated ${new Date(snapshot.updated_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`;
    render();
  } catch {
    $('notice').hidden = false;
    $('notice').textContent = snapshot ? 'Could not refresh. Showing the last successful update; try Refresh again.' : 'Could not load hours. Open this page through your authenticated agent address and try Refresh again.';
    $('updated').textContent = snapshot ? 'Update unavailable' : 'Connection unavailable';
  } finally { busy = false; $('refresh').disabled = false; }
}
function sheetText(value) {
  const text = String(value).replace(/[\t\r\n]+/g, ' ');
  return /^[=+\-@]/.test(text.trimStart()) ? "'" + text : text;
}
$('download').addEventListener('click', () => {
  const { closed } = view();
  if (!$('contractor').value || !closed.length) return;
  const rows = closed.slice().reverse().map(row => [row.day, row.start, row.finish, Math.round((row.end_ms - row.start_ms) / 3600000 * 1000000) / 1000000, row.rate_usd, row.project, row.details]);
  const tsv = [headers, ...rows].map(row => row.map(sheetText).join('\t')).join('\n') + '\n';
  const url = URL.createObjectURL(new Blob([tsv], { type: 'text/tab-separated-values;charset=utf-8' }));
  const link = element('a');
  link.href = url;
  link.download = `hours-${$('contractor').value}.tsv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
for (const id of ['from', 'to']) if (params.has(id)) $(id).value = params.get(id);
$('filters').addEventListener('submit', event => event.preventDefault());
$('filters').addEventListener('change', () => { if (snapshot) render(); });
$('clear').addEventListener('click', () => { for (const id of ['contractor', 'project', 'from', 'to']) $(id).value = ''; if (snapshot) render(); });
$('refresh').addEventListener('click', refresh);
setInterval(() => { if (!document.hidden) refresh(); }, 15000);
refresh();
