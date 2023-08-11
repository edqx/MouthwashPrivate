import express from "express";

import { AccountServer } from "$/index";

export default async function (server: AccountServer, req: express.Request, res: express.Response) {
    if (!req.params.user_id) {
        return res.status(400).json({
            code: 400,
            message: "BAD_REQUEST",
            details: "Expected 'user_id' as part of request endpoint"
        });
    }
    
    const { rows } = await server.postgresClient.query(`
        SELECT bundle_item.*, bundle.bundle_asset_path
        FROM bundle_item
        LEFT JOIN bundle ON bundle.id = bundle_item.bundle_id
        LEFT JOIN user_owned_item ON user_owned_item.item_id = bundle_item.id
        WHERE user_owned_item.user_id = $1
    `, [ req.params.user_id ]);
    
    return res.status(200).json({
        success: true,
        data: rows.map(row => ({
            id: row.id,
            name: row.name,
            among_us_id: row.among_us_id,
            resource_id: row.resource_id,
            resource_path: row.resource_path,
            bundle_asset_path: row.bundle_asset_path,
            type: row.type
        }))
    });
}