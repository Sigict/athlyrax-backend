function text(value) {
  return String(value ?? '').trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function tokenFromEntry(value) {
  if (value && typeof value === 'object') {
    return text(
      value.swimmerId
      || value.athleteId
      || value.attendeeId
      || value.userId
      || value.id
      || value.value
    );
  }
  return text(value);
}

export function collectAttendanceSwimmerIds(row) {
  const raw = row && typeof row === 'object' ? row : {};
  const tokens = [
    raw.swimmerId,
    raw.athleteId,
    raw.attendeeId,
    raw.userId,
    ...asArray(raw.swimmerIds),
    ...asArray(raw.athleteIds),
    ...asArray(raw.attendeeIds),
    ...asArray(raw.attendees),
    ...asArray(raw.participants),
  ]
    .map(tokenFromEntry)
    .filter(Boolean);
  return new Set(tokens);
}

export function attendanceBelongsToSwimmer(row, swimmerId) {
  const selected = text(swimmerId);
  if (!selected) return false;
  return collectAttendanceSwimmerIds(row).has(selected);
}
