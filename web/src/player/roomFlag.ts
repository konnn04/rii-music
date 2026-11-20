// Set by room.ts; read by autofill.ts (separate module to avoid an import cycle).
// While listening in someone else's room, the room decides what plays.
let role: "" | "host" | "controller" | "listener" = "";

export const roomRole = () => role;
export const setRoomRole = (r: typeof role) => {
  role = r;
};
