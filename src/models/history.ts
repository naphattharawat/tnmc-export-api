import { Knex } from "knex";

export class HistoryModel {
  async getHistory(db: Knex.QueryInterface) {
    const sql = db.table('logs as l')
      .select('l.*', 's.name as state_name')
      .join('state as s', 'l.state', 's.id')
      .orderBy('l.id', 'desc')
    return sql;
  }

  async getHistoryWithDetails(db: Knex.QueryInterface) {
    const logs = await db.table('logs').orderBy('id', 'desc');
    const details = await db.table('log_details').orderBy('id', 'desc');
    return { logs, details };
  }
}
