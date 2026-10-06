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
    && (!$('project').value || row.project === $('project').value));
  return { people, valid, closed: rows.filter(row => row.end_ms !== null).sort((a, b) => b.start_ms - a.start_ms || a.id.localeCompare(b.id)), open: rows.filter(row => row.end_ms === null) };
}
function stamp(ms, timezone) {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' }).format(ms);
}
function timezoneLabel(timezone) {
  if (timezone === 'America/Sao_Paulo') return 'São Paulo time';
  return `${timezone.split('/').at(-1).replaceAll('_', ' ')} time`;
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
  const filteredDates = Boolean($('from').value || $('to').value);
  $('scope').textContent = $('contractor').value ? people[0]?.name || 'Unknown contractor' : `${people.length} contractors · ${filteredDates ? 'Billing timezones' : 'All recorded timezones'}`;
  $('date-caption').textContent = filteredDates ? 'Completed time inside the selected dates, using each contractor’s billing timezone.' : 'Completed time entries; dates use each session’s recorded timezone.';
  $('rows').replaceChildren(...closed.map(row => {
    const tr = element('tr');
    const day = element('td', row.day);
    day.append(element('small', row.person.name));
    const project = element('td');
    project.append(element('span', row.project, 'project-pill'));
    tr.append(day, timeCell(row.start, row.day), timeCell(row.finish, row.day), element('td', number.format((row.end_ms - row.start_ms) / 3600000), 'numeric'), element('td', money.format(row.rate_usd), 'numeric'), project, element('td', row.details, 'detail'));
    return tr;
  }));
  renderClocks(open, people);
  $('empty').hidden = closed.length > 0;
  $('empty').querySelector('h3').textContent = valid ? (snapshot.contractors.length ? 'No completed sessions in this view' : 'Ready for your first contractor') : 'Check the date range';
  $('empty').querySelector('p').textContent = valid ? (snapshot.contractors.length ? 'Hours appear when a contractor stops their clock. Try clearing the filters.' : 'Register a contractor and their assigned work with the agent to get started.') : 'The end date must be on or after the start date.';
  $('row-count').textContent = `${closed.length} completed ${closed.length === 1 ? 'session' : 'sessions'}`;
  $('download').disabled = !$('contractor').value || !closed.length || !valid || dates() !== dates(snapshot.date_range);
  $('export-hint').textContent = $('contractor').value ? ($('from').value || $('to').value ? 'Hours include only time inside the selected dates, using the contractor’s billing timezone. Partial sessions retain their original times in Details.' : 'Dates and rates follow each session’s recorded timezone and hourly rate.') : 'Choose a contractor to download their timesheet. Date filters include time worked inside the selected dates.';
  $('demands').replaceChildren(...people.flatMap(person => person.demands.filter(demand => !$('project').value || demand.project === $('project').value).map(demand => {
    const node = element('div', undefined, 'demand');
    const title = element('div', undefined, 'demand-title');
    title.append(element('span', demand.project));
    node.append(title, element('p', `${person.name} · ${demand.summary}`));
    if (demand.references) node.append(element('p', demand.references));
    return node;
  })));
  if (!$('demands').childElementCount) $('demands').append(element('p', 'No assigned work in this view.'));
  renderProfiles(people);
  const query = new URLSearchParams();
  for (const id of ['contractor', 'project', 'from', 'to']) if ($(id).value) query.set(id, $(id).value);
  history.replaceState(null, '', `${location.pathname}${query.size ? '?' + query : ''}`);
  for (const key of [...params.keys()]) params.delete(key);
}
function renderClocks(open, people) {
  const pending = people.filter(person => person.pending_clock.start);
  $('open').hidden = open.length === 0 && pending.length === 0;
  $('open').replaceChildren(...open.map(row => {
    const node = element('div', undefined, 'open-clock');
    node.append(element('span', '', 'dot'), element('strong', `${row.person.name} is working`), element('span', `${row.project || "Work"} · Started ${stamp(row.start_ms, row.timezone)}`), element('small', 'Excluded from recorded total'));
    return node;
  }), ...pending.map(person => {
    const node = element('div', undefined, 'open-clock');
    node.append(element('strong', `${person.name} reported a start`), element('span', stamp(Date.parse(person.pending_clock.start), person.pending_clock.timezone)), element('small', 'Waiting for the contractor to confirm the task. Original start time saved; excluded from totals.'));
    return node;
  }));
}
function renderProfiles(people) {
  $('profiles').replaceChildren(...people.map(person => {
    const node = element('div', undefined, 'profile');
    const title = element('div', person.name, 'profile-title');
    title.append(element('span', `${money.format(person.rate_usd)} / hour`));
    node.append(title, element('p', timezoneLabel(person.timezone)));
    if (!person.active) node.append(element('p', 'Inactive · History retained'));
    if (person.pending_clock.messages) node.append(element('p', `${person.pending_clock.messages} incoming messages awaiting processing. Saved timestamps will be used when processing resumes.`));
    if (person.pending_clock.unmatched_stops) node.append(element('p', 'A finish is waiting for its matching start. Ask the agent to review it in your private chat.'));
    if (person.review_needed) node.append(element('p', 'A session needs your review before billing.'));
    const billing = person.billing;
    if (billing?.requested) {
      node.append(element('p', billingLabel(billing)));
      if (billing.expected) node.append(element('p', billingTotal(billing)));
    }
    return node;
  }));
}
function billingLabel(billing) {
  if (billing.approved) return 'Approved · Pay manually after your checks';
  if (billing.unresolved_clocks) return 'Clock messages pending · Check the private chat';
  if (!billing.closed) return 'Billing period is open';
  if (billing.discrepancy_cents !== null && billing.discrepancy_cents !== 0) return 'Invoice amount needs your review';
  if (billing.ready_for_owner_review) return 'Ready for your approval in the private chat';
  return 'Period closed · Waiting for matching paperwork';
}
function billingTotal(billing) {
  const amount = new Intl.NumberFormat('en-US', { style: 'currency', currency: billing.expected.currency }).format(billing.expected.amount_cents / 100);
  const unit = billing.expected.total_hours === 1 ? 'hour' : 'hours';
  const period = billing.period_start === billing.period_end ? billing.period_start : `${billing.period_start} to ${billing.period_end}`;
  return `${amount} · ${number.format(billing.expected.total_hours)} ${unit} for ${period} in ${timezoneLabel(billing.expected.timezone)}, including all projects`;
}
function dates(range) {
  const query = new URLSearchParams();
  for (const id of ['from', 'to']) { const value = range ? range[id] : $(id).value; if (value) query.set(id, value); }
  return query.toString();
}
async function refresh() {
  if (busy) return;
  if ($('from').value && $('to').value && $('from').value > $('to').value) { if (snapshot) render(); $('notice').hidden = false; $('notice').textContent = 'The end date must be on or after the start date.'; return; }
  busy = true;
  const requested = dates();
  $('refresh').disabled = true;
  try {
    const response = await fetch(`/hours/data${requested ? '?' + requested : ''}`, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('Could not load hours');
    const next = await response.json();
    if (requested !== dates()) return;
    snapshot = next;
    options('contractor', snapshot.contractors.map(person => [person.id, person.name]), 'All contractors');
    options('project', [...new Set(snapshot.contractors.flatMap(person => person.projects))].sort().map(project => [project, project]), 'All projects');
    $('notice').hidden = true;
    $('updated').textContent = `Updated ${new Date(snapshot.updated_at).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`;
    render();
  } catch {
    $('notice').hidden = false;
    $('notice').textContent = snapshot ? 'Could not refresh. Showing the last successful update; try Refresh again.' : 'Could not load hours. Open this page through your authenticated agent address and try Refresh again.';
    $('updated').textContent = snapshot ? 'Update unavailable' : 'Connection unavailable';
  } finally { busy = false; $('refresh').disabled = false; if (requested !== dates()) void refresh(); }
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
function changeFilters() {
  if (snapshot && dates() === dates(snapshot.date_range)) render();
  else { $('download').disabled = true; $('notice').hidden = false; $('notice').textContent = 'Updating selected dates…'; void refresh(); }
}
$('filters').addEventListener('change', changeFilters);
$('clear').addEventListener('click', () => { for (const id of ['contractor', 'project', 'from', 'to']) $(id).value = ''; changeFilters(); });
$('refresh').addEventListener('click', refresh);
setInterval(() => { if (!document.hidden) refresh(); }, 15000);
refresh();
