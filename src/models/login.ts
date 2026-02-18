import { Knex } from 'knex'
export class LoginModel {
  checkAdmin(db: Knex.QueryInterface, cid) {
    return db.table('users')
      .where('cid', cid)
      .where('is_deleted', 'N')
      .limit(1);
  }
}