function cleanDateKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const iso = raw.match(/^(\d{4}-\d{2}-\d{2})T/);
  if (iso) return iso[1];
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return '';
  const year = parsed.getFullYear();
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const day = String(parsed.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toText(value) {
  return String(value || '').trim();
}

export function getSwimmerSquadMoveEvents(swimmer) {
  return []
    .concat(Array.isArray(swimmer?.squadMoves) ? swimmer.squadMoves : [])
    .concat(Array.isArray(swimmer?.squadHistory) ? swimmer.squadHistory : [])
    .map((item) => {
      const date = cleanDateKey(item?.date || item?.at || item?.movedAt || item?.startDate);
      const fromSquadId = toText(item?.fromSquadId || item?.from || item?.previousSquadId || item?.prevSquadId);
      const toSquadId = toText(item?.toSquadId || item?.squadId || item?.to || item?.currentSquadId);
      if (!date || (!fromSquadId && !toSquadId)) return null;
      return { date, fromSquadId, toSquadId };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

export function getSwimmerSquadIdOnDate(swimmer, dateValue) {
  const targetDate = cleanDateKey(dateValue);
  const currentSquadId = toText(swimmer?.currentSquadId);
  if (!targetDate) return currentSquadId;

  let resolvedSquadId = currentSquadId;
  const events = getSwimmerSquadMoveEvents(swimmer);

  for (const event of events) {
    if (targetDate < event.date && event.fromSquadId) {
      resolvedSquadId = event.fromSquadId;
    }
  }

  return resolvedSquadId;
}

export function isSwimmerInSquadOnDate(swimmer, squadId, dateValue) {
  const expectedSquadId = toText(squadId);
  if (!expectedSquadId || expectedSquadId === 'all') return true;
  return getSwimmerSquadIdOnDate(swimmer, dateValue) === expectedSquadId;
}
