import { describe, expect, it } from 'vitest';
import { dbInit } from '../../src/init/init';

function createD1LikeDatabase() {
	const schema = {
		user: new Set(['user_id', 'agent_enabled', 'agent_auto_draft', 'agent_persona']),
		email: new Set(['email_id']),
		agentMessageCreated: false,
		agentMessageIndexCreated: false,
	};

	return {
		schema,
		prepare(query) {
			return {
				async first() {
					const match = query.match(/pragma_table_info\('([a-z_]+)'\).*name = '([a-z_]+)'/);
					if (!match) return undefined;
					const [, table, column] = match;
					return schema[table].has(column) ? {name: column} : undefined;
				},
				async run() {
					const addColumn = query.match(/ALTER TABLE ([a-z_]+) ADD COLUMN ([a-z_]+)/);
					if (addColumn) {
						schema[addColumn[1]].add(addColumn[2]);
						return;
					}
					if (query.includes('CREATE TABLE IF NOT EXISTS agent_message')) {
						schema.agentMessageCreated = true;
						return;
					}
					if (query.includes('CREATE INDEX IF NOT EXISTS idx_agent_message_user')) {
						schema.agentMessageIndexCreated = true;
					}
				},
			};
		},
	};
}

describe('initAgentColumns', () => {
	it('repairs email.ai_metadata when user agent columns already exist', async () => {
		const db = createD1LikeDatabase();

		await dbInit.initAgentColumns({env: {db}});

		expect(db.schema.email.has('ai_metadata')).toBe(true);
		expect(db.schema.agentMessageCreated).toBe(true);
		expect(db.schema.agentMessageIndexCreated).toBe(true);
	});
});
