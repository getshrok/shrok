import { createFileStore } from './file-store.js'

export interface Reminder {
  id: string
  message: string
  channel: string
  runAt: string
  createdAt: string
}

export class ReminderStore {
  private store: ReturnType<typeof createFileStore<Reminder>>

  constructor(dir: string) {
    this.store = createFileStore<Reminder>(dir)
  }

  get(id: string): Reminder | null {
    return this.store.get(id)
  }

  list(): Reminder[] {
    return this.store.list()
  }

  save(reminder: Reminder): Reminder {
    this.store.save(reminder)
    return reminder
  }

  delete(id: string): void {
    this.store.delete(id)
  }
}
