/** Global DSH names must distinguish this database from other memory plugins. */
export const MEMORY_TOOLS = {
  search: "memory_framework_search",
  read: "memory_framework_read",
  remember: "memory_framework_remember",
  taskState: "memory_framework_task_state",
  taskUpdate: "memory_framework_task_update",
  checkpoint: "memory_framework_checkpoint",
} as const;
