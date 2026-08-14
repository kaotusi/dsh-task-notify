import { z } from 'zod'

const ID = '@deepseek-ai/dsh-task-notify#taskNotify'

const TaskNotifyRecord = z.object({
  id: z.string(),
  kind: z.string(),
  subkind: z.string(),
  label: z.string(),
  detail: z.string(),
  outcome: z.string(),
  at: z.number(),
  read: z.boolean(),
})

const DiagState = z.object({
  supported: z.boolean(),
  permission: z.string(),
  secure: z.boolean(),
  at: z.number(),
}).passthrough()

export const TYPERT = {
  package: '@deepseek-ai/dsh-task-notify',
  face: 'host',
  schemas: [],
  model: { services: [], events: [], objects: [] },
  invocations: [
    {
      id: ID + '/pull',
      service: 'taskNotify',
      namespace: 'taskNotify',
      method: 'pull',
      invocation: { kind: 'direct' },
      parameters: [],
      result: {
        mode: 'strict',
        typeSymbol: '@deepseek-ai/dsh-task-notify/types#TaskNotifyRecordList',
        schema: z.array(TaskNotifyRecord),
      },
    },
    {
      id: ID + '/ack',
      service: 'taskNotify',
      namespace: 'taskNotify',
      method: 'ack',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'id', wire: 'id', source: 'json', codec: { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-task-notify/types#TaskNotifyId', schema: z.string() } },
      ],
      result: { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-task-notify/types#Null', schema: z.null() },
    },
    {
      id: ID + '/clear',
      service: 'taskNotify',
      namespace: 'taskNotify',
      method: 'clear',
      invocation: { kind: 'direct' },
      parameters: [],
      result: { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-task-notify/types#Null', schema: z.null() },
    },
    {
      id: ID + '/purge',
      service: 'taskNotify',
      namespace: 'taskNotify',
      method: 'purge',
      invocation: { kind: 'direct' },
      parameters: [],
      result: { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-task-notify/types#Null', schema: z.null() },
    },
    {
      id: ID + '/diag',
      service: 'taskNotify',
      namespace: 'taskNotify',
      method: 'diag',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'state', wire: 'state', source: 'json', codec: { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-task-notify/types#TaskNotifyDiagState', schema: DiagState } },
      ],
      result: { mode: 'strict', typeSymbol: '@deepseek-ai/dsh-task-notify/types#Null', schema: z.null() },
    },
  ],
}
