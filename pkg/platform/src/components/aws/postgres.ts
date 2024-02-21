import { ComponentResourceOptions, output, Output } from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { Component, Transform, transform } from "../component";
import { Link } from "../link";
import { Input } from "../input.js";

export interface PostgresArgs {
  /**
   * The Postgres engine version. Check out the [available versions in your region](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Concepts.Aurora_Fea_Regions_DB-eng.Feature.ServerlessV2.html#Concepts.Aurora_Fea_Regions_DB-eng.Feature.ServerlessV2.apg).
   * @default `"15.5"`
   * @example
   * ```js
   * {
   *   version: "13.9"
   * }
   * ```
   */
  version?: Input<string>;
  /**
   * Name of a database which is automatically created inside the cluster.
   * @default Database not created
   * @example
   * ```js
   * {
   *   databaseName: "app"
   * }
   * ```
   */
  databaseName?: Input<string>;
  /**
   * The Aurora Serverless v2 scaling config. By default, the cluster has one DB instance that
   * is used for both writes and reads. The instance can scale from the minimum number of ACUs
   * to the maximum number of ACUs.
   *
   * :::caution
   * Aurora Serverless v2 does not scale down to 0. The minimum cost of a Postgres cluster
   * per month is roughly `0.5 * $0.12 per ACU hour * 24 hrs * 30 days = $43.20`.
   * :::
   *
   * An ACU or Aurora Capacity Unit is a combination of CPU and RAM. The cost of an Aurora Serverless v2 cluster is based on the ACU hours
   * used. Additionally, you are billed for I/O and storage used by the cluster.
   * [Read more here](https://aws.amazon.com/rds/aurora/pricing/).
   *
   * Each ACU is roughly equivalent to 2 GB of memory. So pick the minimum and maximum
   * based on the baseline and peak memory usage of your app.
   *
   * @default `&lcub;min: 0.5, max: 4&rcub;`
   */
  scaling?: Input<{
    /**
     * The minimum number of ACUs, ranges from 0.5 to 128, in increments of 0.5.
     *
     * For your production workloads, setting a minimum of 0.5 ACUs might not be a great idea due
     * to the following reasons, you can also [read more here](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2.setting-capacity.html#aurora-serverless-v2.setting-capacity.incompatible_parameters).
     * - It takes longer to scale from a low number of ACUs to a much higher number.
     * - Query performance depends on the buffer cache. So if frequently accessed data cannot
     *   fit into the buffer cache, you might see uneven performance.
     * - The max connections for a 0.5 ACU Postgres instance is capped at 2000.
     *
     * @default `0.5`
     * @example
     * ```js
     * {
     *   scaling: {
     *     min: 2
     *   }
     * }
     * ```
     */
    min?: Input<number>;
    /**
     * The maximum number of ACUs, ranges from 0.5 to 128, in increments of 0.5.
     *
     * @default `4`
     * @example
     * ```js
     * {
     *   scaling: {
     *     max: 128
     *   }
     * }
     * ```
     */
    max?: Input<number>;
  }>;
  /**
   * [Transform](/docs/components#transform/) how this component creates its underlying
   * resources.
   */
  transform?: {
    /**
     * Transform the RDS Cluster.
     */
    cluster?: Transform<aws.rds.ClusterArgs>;
    /**
     * Transform the database instance in the RDS Cluster.
     */
    instance?: Transform<aws.rds.ClusterInstanceArgs>;
  };
}

/**
 * The `Postgres` component lets you add a Postgres database to your app using
 * [Amazon Aurora Serverless v2](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2.html).
 *
 * @example
 *
 * #### Minimal example
 *
 * ```js
 * new sst.aws.Postgres("MyDatabase");
 * ```
 *
 * #### Change the scaling config
 *
 * ```js
 * new sst.aws.Postgres("MyDatabase", {
 *   scaling: {
 *     min: 2,
 *     max: 128
 *   }
 * });
 * ```
 */
export class Postgres
  extends Component
  implements Link.Linkable, Link.AWS.Linkable
{
  private cluster: aws.rds.Cluster;
  private instance: aws.rds.ClusterInstance;
  private databaseName: Output<string>;

  constructor(
    name: string,
    args?: PostgresArgs,
    opts?: ComponentResourceOptions,
  ) {
    super("sst:aws:Postgres", name, args, opts);

    const parent = this;
    const scaling = normalizeScaling();
    const version = normalizeVersion();
    const databaseName = normalizeDatabaseName();

    const cluster = createCluster();
    const instance = createInstance();

    this.cluster = cluster;
    this.instance = instance;
    this.databaseName = databaseName;

    function normalizeScaling() {
      return output(args?.scaling).apply((scaling) => ({
        minCapacity: scaling?.min ?? 0.5,
        maxCapacity: scaling?.max ?? 4,
      }));
    }

    function normalizeVersion() {
      return output(args?.version).apply((version) => version ?? "15.5");
    }

    function normalizeDatabaseName() {
      return output(args?.databaseName).apply((name) => name ?? $app.name);
    }

    function createCluster() {
      return new aws.rds.Cluster(
        `${name}Cluster`,
        transform(args?.transform?.cluster, {
          engine: aws.rds.EngineType.AuroraPostgresql,
          engineMode: "provisioned",
          engineVersion: version,
          databaseName,
          masterUsername: "postgres",
          manageMasterUserPassword: true,
          serverlessv2ScalingConfiguration: scaling,
          skipFinalSnapshot: true,
          enableHttpEndpoint: true,
        }),
        {
          parent,
        },
      );
    }

    function createInstance() {
      return new aws.rds.ClusterInstance(
        `${name}Instance`,
        transform(args?.transform?.instance, {
          clusterIdentifier: cluster.id,
          instanceClass: "db.serverless",
          engine: aws.rds.EngineType.AuroraPostgresql,
          engineVersion: cluster.engineVersion,
        }),
        {
          parent,
        },
      );
    }
  }

  public get nodes() {
    return {
      cluster: this.cluster,
      instance: this.instance,
    };
  }

  /** @internal */
  public getSSTLink() {
    return {
      type: `{ clusterArn: string; secretArn: string; databaseName: string }`,
      value: {
        clusterArn: this.cluster.arn,
        secretArn: this.cluster.masterUserSecrets[0].secretArn,
        databaseName: this.databaseName,
      },
    };
  }

  /** @internal */
  public getSSTAWSPermissions() {
    return [
      {
        actions: ["secretsmanager:GetSecretValue"],
        resources: [this.cluster.masterUserSecrets[0].secretArn],
      },
      {
        actions: ["rds-data:ExecuteStatement"],
        resources: [this.cluster.arn],
      },
    ];
  }
}