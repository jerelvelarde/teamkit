import { EventSchemas } from "@ag-ui/core/schemas";

export function assertAguiValid(events: unknown[]): void {
  events.forEach((e, i) => {
    const r = EventSchemas.safeParse(e);
    if (!r.success) {
      throw new Error(`AG-UI event at index ${i} is invalid: ${r.error.message}`);
    }
  });
}
