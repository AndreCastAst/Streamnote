// Alternativa a Terraform para crear los recursos en el emulador local (moto).
// Terraform (infra/terraform/envs/local) es la fuente de verdad; usa esto solo si
// Terraform no está disponible. Crea exactamente los mismos nombres y reglas.
import { SQSClient, CreateQueueCommand, GetQueueAttributesCommand, SetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { EventBridgeClient, CreateEventBusCommand, PutRuleCommand, PutTargetsCommand } from '@aws-sdk/client-eventbridge';
import { S3Client, CreateBucketCommand, PutBucketLifecycleConfigurationCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient, CreateTableCommand } from '@aws-sdk/client-dynamodb';
import { loadConfig } from '../config.js';

const cfg = loadConfig();
const prefix = process.env.RESOURCE_PREFIX ?? 'streamnote-local';
const client = { region: cfg.aws.region, endpoint: cfg.aws.endpoint, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } };
const sqs = new SQSClient(client);
const eb = new EventBridgeClient(client);
const s3 = new S3Client({ ...client, forcePathStyle: true });
const ddb = new DynamoDBClient(client);

const ignore = (...names: string[]) => (e: any) => {
  if (!names.includes(e.name) && !names.includes(e.Code)) throw e;
};

async function queueWithDlq(name: string, visibility: number, maxReceive: number) {
  const dlq = await sqs.send(new CreateQueueCommand({ QueueName: `${prefix}-${name}-dlq`, Attributes: { MessageRetentionPeriod: '1209600' } }));
  const dlqArn = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] }))).Attributes!.QueueArn;
  const q = await sqs.send(new CreateQueueCommand({ QueueName: `${prefix}-${name}` }));
  await sqs.send(
    new SetQueueAttributesCommand({
      QueueUrl: q.QueueUrl,
      Attributes: {
        VisibilityTimeout: String(visibility),
        MessageRetentionPeriod: '1209600', // 14 días: RNF-05
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlqArn, maxReceiveCount: maxReceive }),
      },
    }),
  );
  const arn = (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: q.QueueUrl, AttributeNames: ['QueueArn'] }))).Attributes!.QueueArn!;
  console.log(`cola ${name}: ${q.QueueUrl}`);
  return arn;
}

await queueWithDlq('note-writes', 90, 3);
const eventsArn = await queueWithDlq('domain-events', 30, 3);
await queueWithDlq('media-jobs', 300, 10);

const bus = `${prefix}-bus`;
await eb.send(new CreateEventBusCommand({ Name: bus })).catch(ignore('ResourceAlreadyExistsException'));
await eb.send(new PutRuleCommand({ Name: `${prefix}-domain-events`, EventBusName: bus, EventPattern: JSON.stringify({ source: ['streamnote.app'] }) }));
await eb.send(new PutTargetsCommand({ Rule: `${prefix}-domain-events`, EventBusName: bus, Targets: [{ Id: 'domain-events-queue', Arn: eventsArn }] }));
console.log(`bus ${bus} → domain-events`);

const bucket = `${prefix}-recordings`;
await s3.send(new CreateBucketCommand({ Bucket: bucket })).catch(ignore('BucketAlreadyOwnedByYou', 'BucketAlreadyExists'));
await s3.send(
  new PutBucketLifecycleConfigurationCommand({
    Bucket: bucket,
    LifecycleConfiguration: {
      Rules: [
        { ID: 'borrar-provisionales', Status: 'Enabled', Filter: { Tag: { Key: 'estado', Value: 'provisional' } }, Expiration: { Days: 3 } },
        {
          ID: 'degradar-conservadas',
          Status: 'Enabled',
          Filter: { Tag: { Key: 'estado', Value: 'conservada' } },
          Transitions: [
            { Days: 30, StorageClass: 'GLACIER_IR' },
            { Days: 180, StorageClass: 'DEEP_ARCHIVE' },
          ],
        },
      ],
    },
  }),
);
console.log(`bucket ${bucket} con ciclo de vida`);

await ddb
  .send(
    new CreateTableCommand({
      TableName: `${prefix}-notifications`,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'userId', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'userId', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
    }),
  )
  .catch(ignore('ResourceInUseException'));
console.log(`tabla ${prefix}-notifications`);
console.log('Recursos locales listos');
