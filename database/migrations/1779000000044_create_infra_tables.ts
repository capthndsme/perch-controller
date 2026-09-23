import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * The infrastructure view (docs/infrastructure-view.md section 5.1): the
 * devices on the network map, their Ethernet ports and the cables between
 * them.
 *
 * - `infra_nodes`: one row per device on the map. A node is bound to the
 *   agent row it stands for (`collector_id`: the Gateway agent, `ap_id`: an
 *   access point) or drawn by the operator. Deleting the agent row detaches
 *   the node (SET NULL) instead of taking the operator's cabling with it.
 *   `origin` remembers that a node was ever bound (amendment A2), which is
 *   what tells a detached node from a manual one.
 * - `infra_ports`: the latest state of every port an agent reports, plus the
 *   ports the operator adds by hand. No history: a latest-state mirror like
 *   `wifi_network_latest`. The operator's `label` / `role` / `medium`
 *   override the agent's `reported_*` values (null = use the agent's).
 * - `infra_links`: one cable between two ports, `a_port_id` the smaller id.
 *   One link per port is enforced by the two unique indexes and, in the
 *   service, by a locking read before every write.
 *
 * Plain string columns for the unions (`kind`, `origin`, `role`, `medium`),
 * enforced in the app layer, house style (`users.role`,
 * `device_labels.device_type`). No retention: these are operator rows and
 * latest state; ports die with their node and links with their ports.
 */
export default class extends BaseSchema {
  async up() {
    this.schema.createTable('infra_nodes', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table.string('kind', 24).notNullable()
      // `agent` once the node has ever been bound to an agent row, else `manual`.
      table.string('origin', 8).notNullable().defaultTo('manual')
      table.string('name', 80).nullable()
      table
        .integer('collector_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('collectors')
        .onDelete('SET NULL')
      table
        .integer('ap_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('wifi_access_points')
        .onDelete('SET NULL')
      // A MAC from the device list. No FK: `device_identities.mac` has another
      // collation, and the device may not have been seen yet.
      table.string('device_mac', 17).nullable()
      table
        .integer('parent_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('infra_nodes')
        .onDelete('SET NULL')
      table.boolean('virtual').notNullable().defaultTo(false)
      table.string('model', 80).nullable()
      table.string('notes', 500).nullable()
      // Null = unplaced; relative to the parent frame when `parent_id` is set.
      table.integer('pos_x').nullable()
      table.integer('pos_y').nullable()
      table.smallint('width').unsigned().nullable()
      table.smallint('height').unsigned().nullable()
      table.boolean('hidden').notNullable().defaultTo(false)
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.index(['kind'], 'infra_nodes_kind_idx')
      table.index(['parent_id'], 'infra_nodes_parent_id_idx')
      table.index(['device_mac'], 'infra_nodes_device_mac_idx')
      // Many NULLs are allowed in a unique index: detached and manual nodes.
      table.unique(['collector_id'], 'infra_nodes_collector_id_unique_idx')
      table.unique(['ap_id'], 'infra_nodes_ap_id_unique_idx')
    })

    this.schema.createTable('infra_ports', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table
        .integer('node_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('infra_nodes')
        .onDelete('CASCADE')
      table.string('port_key', 32).notNullable()
      table.string('origin', 8).notNullable()
      table.string('label', 48).nullable()
      table.string('reported_label', 48).nullable()
      table.string('role', 8).nullable()
      table.string('reported_role', 8).nullable()
      table.string('medium', 8).nullable()
      table.string('reported_medium', 8).nullable()
      table.string('mac', 17).nullable()
      table.smallint('position').unsigned().notNullable().defaultTo(0)
      table.boolean('hidden').notNullable().defaultTo(false)
      table.boolean('present').notNullable().defaultTo(true)
      table.datetime('missing_since').nullable()
      table.boolean('admin_up').nullable()
      table.boolean('carrier').nullable()
      table.string('operstate', 16).nullable()
      table.integer('speed_mbps').unsigned().nullable()
      table.string('duplex', 4).nullable()
      table.integer('carrier_changes').unsigned().nullable()
      table.datetime('state_changed_at').nullable()
      table.datetime('reported_at').nullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.unique(['node_id', 'port_key'], 'infra_ports_node_key_unique_idx')
      table.index(['node_id', 'position'], 'infra_ports_node_position_idx')
    })

    this.schema.createTable('infra_links', (table) => {
      table.collate('utf8mb4_unicode_ci')

      table.increments('id').notNullable()
      table
        .integer('a_port_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('infra_ports')
        .onDelete('CASCADE')
      table
        .integer('b_port_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('infra_ports')
        .onDelete('CASCADE')
      table.string('medium', 8).notNullable().defaultTo('ethernet')
      table.string('label', 48).nullable()
      table.string('notes', 500).nullable()
      table.timestamp('created_at').notNullable()
      table.timestamp('updated_at').nullable()

      table.unique(['a_port_id'], 'infra_links_a_port_unique_idx')
      table.unique(['b_port_id'], 'infra_links_b_port_unique_idx')
    })
  }

  async down() {
    this.schema.dropTable('infra_links')
    this.schema.dropTable('infra_ports')
    this.schema.dropTable('infra_nodes')
  }
}
