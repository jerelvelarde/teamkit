import type { Tool } from "@ag-ui/core";

export const BOARD_TOOL_NAMES = [
  "teamkit_create_task",
  "teamkit_reply",
  "teamkit_label",
  "teamkit_answer",
  "teamkit_read",
] as const;

export type BoardToolName = (typeof BOARD_TOOL_NAMES)[number];

export function isBoardTool(name: string): name is BoardToolName {
  return (BOARD_TOOL_NAMES as readonly string[]).includes(name);
}

export const boardToolDefinitions: Tool[] = [
  {
    name: "teamkit_create_task",
    description: "Create a new task in a TeamKit room, with optional labels and the tasks it waits on.",
    parameters: {
      type: "object",
      properties: {
        room: { type: "string", description: "Room name or id to create the task in." },
        brief: { type: "string", description: "What the task asks for." },
        labels: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Labels to put on the task, as key-value strings.",
        },
        needs: {
          type: "array",
          items: { type: "string" },
          description: "Ids of tasks (th_…) that must complete before this one can start.",
        },
      },
      required: ["room", "brief"],
      additionalProperties: false,
    },
  },
  {
    name: "teamkit_reply",
    description: "Post a reply message to a TeamKit task thread.",
    parameters: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Id of the thread to reply to." },
        text: { type: "string", description: "Reply text." },
      },
      required: ["threadId", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "teamkit_label",
    description: "Set one label on a TeamKit task thread.",
    parameters: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Id of the thread to label." },
        key: { type: "string", description: "Label key." },
        value: { type: "string", description: "Label value." },
      },
      required: ["threadId", "key", "value"],
      additionalProperties: false,
    },
  },
  {
    name: "teamkit_answer",
    description:
      "Answer a question that blocks a TeamKit task so the task can continue; approvals need a person and will be refused.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Id of the blocked task." },
        text: { type: "string", description: "Free-text answer." },
        choice: { type: "string", description: "One of the offered options, when the question has options." },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
  },
  {
    name: "teamkit_read",
    description: "Read the current messages and state of a TeamKit task thread.",
    parameters: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Id of the thread to read." },
      },
      required: ["threadId"],
      additionalProperties: false,
    },
  },
];
