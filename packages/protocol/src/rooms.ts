export const ROOM_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}(\/[a-z0-9][a-z0-9-]{0,62}){0,4}$/;

export function isValidRoom(name: string): boolean {
  return ROOM_PATTERN.test(name);
}

/** "*" matches all; a trailing "/" matches the room without it and everything under it; else exact. */
export function roomMatches(filter: string, room: string): boolean {
  if (filter === "*") return true;
  if (filter.endsWith("/")) {
    return room === filter.slice(0, -1) || room.startsWith(filter);
  }
  return filter === room;
}

export function isValidRoomPattern(p: string): boolean {
  if (p === "*") return true;
  if (isValidRoom(p)) return true;
  return p.endsWith("/") && isValidRoom(p.slice(0, -1));
}
