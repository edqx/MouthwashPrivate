import * as mediator from "mouthwash-mediator";
import { BaseRoute } from "../BaseRoute";

export class BundlesRoute extends BaseRoute {
    @mediator.Endpoint(mediator.HttpMethod.GET, "/v2/bundles")
    async getAllAvailableBundles(transaction: mediator.Transaction<{}>) {
        const { text_search: textSearchQuery, valuations: valuationsQuery } = transaction.getQueryParams();

        const textSearch = typeof textSearchQuery === "string" ? textSearchQuery : "";
        const valuations = typeof valuationsQuery === "string"
            ? valuationsQuery.split(",")
            : [ "GHOST", "CREWMATE", "IMPOSTOR", "POLUS" ];
        const available = await this.server.cosmeticsController.getAllAvailableBundles(textSearch, valuations);
        transaction.respondJson(available);
    }
}