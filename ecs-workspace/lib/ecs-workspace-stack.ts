import * as cdk from 'aws-cdk-lib';
import {aws_ec2, aws_ecr, aws_ecs, aws_iam} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import {PortMap} from "aws-cdk-lib/aws-ecs";

function getAmi(arch: string): string {
    switch (arch) {
        case "arm":
            return "resolve:ssm:/aws/service/ecs/optimized-ami/amazon-linux-2/kernel-5.10/arm64/recommended/image_id";
        default:
            return "resolve:ssm:/aws/service/ecs/optimized-ami/amazon-linux-2/kernel-5.10/recommended/image_id";
    }
}

function getInstance(arch: string): aws_ec2.InstanceType {
    switch (arch) {
        case "arm":
            return aws_ec2.InstanceType.of(aws_ec2.InstanceClass.T4G, aws_ec2.InstanceSize.MEDIUM);
        default:
            return aws_ec2.InstanceType.of(aws_ec2.InstanceClass.T3A, aws_ec2.InstanceSize.MEDIUM);
    }
}

export class EcsWorkspaceStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // assume that we have:
        // default vpc, ecsInstanceRole, and default security group
        const defaultVpc = aws_ec2.Vpc.fromLookup(this, "defaultVpc", {isDefault: true});
        const instance_role = aws_iam.Role.fromRoleName(this, "instance_role", "ecsInstanceRole");
        const task_execution_role = aws_iam.Role.fromRoleName(this, "task_execution_role", "ecsExecutionRole");
        const sg_default = aws_ec2.SecurityGroup.fromLookupByName(this, "securityGroupDefault", "default", defaultVpc);
        // use ssh for ec2-instance-connect but disable keypair in templates
        const sg_ssh = new aws_ec2.SecurityGroup(this, "securityGroupSsh", {
            securityGroupName: "ssh",
            vpc: defaultVpc,
        });
        sg_ssh.addIngressRule(aws_ec2.Peer.anyIpv4(), aws_ec2.Port.tcpRange(22, 22), "ssh access");
        const sg_http = new aws_ec2.SecurityGroup(this, "securityGroupHttp", {
            securityGroupName: "http/https",
            vpc: defaultVpc,
        });
        sg_http.addIngressRule(aws_ec2.Peer.anyIpv4(), aws_ec2.Port.tcpRange(80, 80), "http access");
        sg_http.addIngressRule(aws_ec2.Peer.anyIpv4(), aws_ec2.Port.tcpRange(443, 443), "https access");
        const tpls= ["x86", "arm"].map((arch: string) => {
            const tplProps: aws_ec2.LaunchTemplateProps = {
                launchTemplateName: arch,
                instanceType: getInstance(arch),
                role: instance_role,
                cpuCredits: aws_ec2.CpuCredits.UNLIMITED,
                ebsOptimized: true,
                securityGroup: sg_default,
                machineImage: aws_ec2.MachineImage.latestAmazonLinux2(), // will override
            }
            return tplProps;
        }).map((templateProps) => {
            const tpl = new aws_ec2.LaunchTemplate(this, templateProps.launchTemplateName!, templateProps);
            const cfnTpl = tpl.node.defaultChild as aws_ec2.CfnLaunchTemplate
            cfnTpl.addOverride(
                "Properties.LaunchTemplateData.ImageId",
                getAmi(templateProps.launchTemplateName!)
            );
            cfnTpl.addOverride(
                "Properties.LaunchTemplateData.UserData",
                ""
            );
            return tpl;
        });
        const clusterArn = this.formatArn({
            account: this.account,
            partition: "aws",
            region: this.region,
            resource: "cluster",
            resourceName: "default",
            service: "ecs",
        });
        const cluster = aws_ecs.Cluster.fromClusterArn(this, "defaultEcsCluster", clusterArn);

        const basicNginxTask = new aws_ecs.TaskDefinition(this, "nginxTaskDef", {
            compatibility: aws_ecs.Compatibility.EC2_AND_FARGATE,
            cpu: "256",
            executionRole: task_execution_role,
            family: "nginx",
            memoryMiB: "512",
            networkMode: aws_ecs.NetworkMode.AWS_VPC,
        });
        basicNginxTask.addContainer("nginxContainer", {
            containerName: "web",
            essential: true,
            image: aws_ecs.ContainerImage.fromRegistry("public.ecr.aws/nginx/nginx:stable"),
            portMappings: [{containerPort: 80}],
            memoryReservationMiB: 512,
        });
    };
}
