import { Knex } from 'knex'
export class DataModel {
  getState(db: Knex.QueryInterface) {
    return db.table('config')
      .limit(1);
  }
  setState(db: Knex.QueryInterface, state: number) {
    return db.table('config').update({ state: state })
  }
  saveLogs(db: Knex.QueryInterface, state: number) {
    return db.table('log_details').insert({ state_id: state })
  }

  getData(db: Knex.QueryInterface) {
    return db.table('data')
  }
  getDataLKPending(db: Knex.QueryInterface) {
    return db.table('data').where('status', 'PENDING').andWhere('status_lk', 'PENDING');
  }
  getDataPOPPending(db: Knex.QueryInterface) {
    return db.table('data').where('status', 'PENDING').andWhere('status_checkpop', 'PENDING');
  }
  updateData(db: Knex.QueryInterface, id: number, data: any) {
    return db.table('data').where('id', id).update(data)
  }
  saveData(db: Knex.QueryInterface, data: any) {
    return db.table('data').insert(data)
  }
  removeData(db: Knex.QueryInterface) {
    return db.table('data').delete();
  }
  checkDataDone(db: Knex.QueryInterface) {
    return db.table('data').where('status', 'PENDING').count('id as count');
  }
  checkDataLKDone(db: Knex.QueryInterface) {
    return db.table('data').where('status_lk', 'PENDING').where('status', 'PENDING').count('id as count');
  }
  checkDataPOPDone(db: Knex.QueryInterface) {
    return db.table('data').where('status_checkpop', 'PENDING').count('id as count');
  }

  getTokenLK(db: Knex.QueryInterface) {
    return db.table('token').whereIn('status', ['ACTIVE', 'ACTIVED']).orderBy('updated_date', 'desc')
  }

  updateTokenLK(db: Knex.QueryInterface, cid: number, data: any) {
    return db.table('token').where('cid', cid).update(data)
  }

  async upsertTokenLK(db: Knex.QueryInterface, data: { cid: string; token: string; status: string }) {
    const updated = await db.table('token').where('cid', data.cid).update({
      token: data.token,
      status: data.status,
    });
    if (!updated) {
      await db.table('token').insert({
        cid: data.cid,
        token: data.token,
        status: data.status,
      });
    }
  }

  getUsers(db: Knex.QueryInterface) {
    return db.table('users')
      .where((q: any) => {
        q.whereNull('is_deleted').orWhere('is_deleted', '!=', 'Y');
      });
  }
  async upsertUser(db: Knex.QueryInterface, data: { cid: string; name: string }) {
    const updated = await db.table('users').where('cid', data.cid).update({
      name: data.name,
      is_deleted: 'N',
    });
    if (!updated) {
      await db.table('users').insert({
        cid: data.cid,
        name: data.name,
        is_deleted: 'N',
      });
    }
  }
  softDeleteUser(db: Knex.QueryInterface, cid: string) {
    return db.table('users').where('cid', cid).update({ is_deleted: 'Y' });
  }
  async updateUserName(db: Knex.QueryInterface, cid: string, name: string) {
    return db.table('users').where('cid', cid).update({
      name,
      is_deleted: 'N',
    });
  }

  getConfigDatetime(db: Knex.QueryInterface) {
    return db.table('config_datetime');
  }
  saveConfigDatetime(db: Knex.QueryInterface, data: { dd: number; mm: number; time: string; hour: number }) {
    return db.table('config_datetime').delete().then(() => db.table('config_datetime').insert(data));
  }
  async saveConfigDatetimeMany(db: Knex.QueryInterface, rows: Array<{ dd: number; mm: number; time: string; hour: number }>) {
    await db.table('config_datetime').delete();
    if (rows.length) {
      await db.table('config_datetime').insert(rows);
    }
  }
}
