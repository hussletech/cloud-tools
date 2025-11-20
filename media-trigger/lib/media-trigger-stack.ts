import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as path from 'path';

export interface MediaTriggerStackProps extends cdk.StackProps {
  existingBucketName?: string;
  mediaConvertQueueArn?: string;
  mediaConvertRoleArn?: string;
}

export class MediaTriggerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: MediaTriggerStackProps) {
    super(scope, id, props);

    const mediaConvertQueueArn = props?.mediaConvertQueueArn || 
      'arn:aws:mediaconvert:us-east-1:964957925184:queues/Default';
    const mediaConvertRoleArn = props?.mediaConvertRoleArn || 
      'arn:aws:iam::964957925184:role/service-role/MediaConvert_Default_Role';

    const inputBucket = s3.Bucket.fromBucketName(this, 'InputBucket', "assets.soundconcepts.com");

    const mediaConvertLambda = new lambda.Function(this, 'MediaConvertLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '../lambda')),
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: {
        MEDIA_CONVERT_QUEUE_ARN: mediaConvertQueueArn,
        MEDIA_CONVERT_ROLE_ARN: mediaConvertRoleArn,
        INPUT_BUCKET_NAME: inputBucket.bucketName,
      },
    });

    mediaConvertLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'mediaconvert:CreateJob',
        'mediaconvert:DescribeEndpoints',
      ],
      resources: ['*'],
    }));

    mediaConvertLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'iam:PassRole',
      ],
      resources: [mediaConvertRoleArn],
    }));

    inputBucket.grantRead(mediaConvertLambda);
    inputBucket.grantWrite(mediaConvertLambda);

    const rule = new events.Rule(this, 'S3MP4UploadRule', {
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created'],
        detail: {
          bucket: {
            name: [inputBucket.bucketName],
          },
        },
      },
      description: 'Trigger MediaConvert job when MP4 file is uploaded to webroot_*/assets/video/ in S3',
    });

    rule.addTarget(new targets.LambdaFunction(mediaConvertLambda));

    new cdk.CfnOutput(this, 'InputBucketName', {
      value: inputBucket.bucketName,
      description: 'S3 bucket name for input MP4 files',
    });

    new cdk.CfnOutput(this, 'LambdaFunctionArn', {
      value: mediaConvertLambda.functionArn,
      description: 'Lambda function ARN that processes MediaConvert jobs',
    });

    new cdk.CfnOutput(this, 'EventBridgeRuleArn', {
      value: rule.ruleArn,
      description: 'EventBridge rule ARN',
    });
  }
}

