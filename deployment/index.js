const pulumi = require("@pulumi/pulumi");
const aws = require("@pulumi/aws");
const awsx = require("@pulumi/awsx");

// The follow fields need to be in the Pulumi.yaml file
// aws:region:  ${AWSREGION}
// aws:account: ${AWSACCOUNTID}
const config = new pulumi.Config();
const region = config.require("region");
const account = config.require("account");

const vpc = awsx.ec2.Vpc.getDefault();

const PublicSecurity = new awsx.ec2.SecurityGroup("PublicSecurity", {
    ingress: [{ protocol: "tcp", fromPort: 80, toPort: 80, cidrBlocks: ["0.0.0.0/0"], ipv6CidrBlocks: ["::/0"] }]
});

const DockerSecurity =  new awsx.ec2.SecurityGroup("DockerSecurity", {
    ingress: [
        { protocol: "tcp", fromPort: 22, toPort: 22, cidrBlocks: ["0.0.0.0/0"], ipv6CidrBlocks: ["::/0"] },
        { protocol: "tcp", fromPort: 8080, toPort: 8080, cidrBlocks: ["0.0.0.0/0"], ipv6CidrBlocks: ["::/0"] },
        { protocol: "tcp", fromPort: 5432, toPort: 5432, cidrBlocks: ["0.0.0.0/0"], ipv6CidrBlocks: ["::/0"] }
    ],
});

const ClusterSecurity = new awsx.ec2.SecurityGroup("ClusterSecurity", {
    ingress: [{ protocol: "tcp", fromPort: 22, toPort: 22, sourceSecurityGroupId: DockerSecurity.id }],
}, {
    dependsOn: DockerSecurity
});

const ALBSecurity = new awsx.ec2.SecurityGroup("ALBSecurity", {
    egress: [{ protocol: "tcp", fromPort: 0, toPort: 65535, cidrBlocks: ["0.0.0.0/0"], ipv6CidrBlocks: ["::/0"] }],
    ingress: [{ protocol: "tcp", fromPort: 80, toPort: 80, cidrBlocks: ["0.0.0.0/0"], ipv6CidrBlocks: ["::/0"] }],
});

const DB_HOST = new aws.ssm.Parameter("DB_HOST", {
    name: "DB_HOST",
    type: "SecureString",
    value: "localhost",
});

const DB_USER = new aws.ssm.Parameter("DB_USER", {
    name: "DB_USER",
    type: "SecureString",
    value: "postgres",
});

const DB_NAME = new aws.ssm.Parameter("DB_NAME", {
    name: "DB_NAME",
    type: "SecureString",
    value: "openlawnz_db",
});

const DB_PASS = new aws.ssm.Parameter("DB_PASS", {
    name: "DB_PASS",
    type: "SecureString",
    value: "pgpass",
});

const PORT = new aws.ssm.Parameter("PORT", {
    name: "PORT",
    type: "SecureString",
    value: "5432",
});

const lb = new awsx.lb.ApplicationLoadBalancer("openlawnz-elb", {
    name: "openlawnz-elb",
    securityGroups: ALBSecurity,
    port: 80
})


const taskDefinition =  new awsx.ecs.EC2TaskDefinition(`openlaw-task`, {
    networkMode: "bridge",
    family: "openlawnz",
    container: {
        image: `${account}.dkr.ecr.${region}.amazonaws.com/ParserCloud:latest`,
        logConfiguration: {
            logDriver: "awslogs",
            options: {
                "awslogs-group": "/ecs/openlawnz",
                "awslogs-region": region,
                "awslogs-stream-prefix": "ecs"
            }
        },
        portMappings: [{
            hostPort: 0,
            protocol: "tcp",
            containerPort: 80
        }, ...lb.listeners],
        secrets: [
            {
                "name": "DB_NAME",
                "valueFrom": `arn:aws:ssm:${region}:${account}:parameter/DB_NAME`
            },
            {
                "name": "DB_HOST",
                "valueFrom": `arn:aws:ssm:${region}:${account}:parameter/DB_HOST`
            },
            {
                "name": "DB_USER",
                "valueFrom": `arn:aws:ssm:${region}:${account}:parameter/DB_USER`
            },
            {
                "name": "DB_PASS",
                "valueFrom": `arn:aws:ssm:${region}:${account}:parameter/DB_PASS`
            },
            {
                "name": "PORT",
                "valueFrom": `arn:aws:ssm:${region}:${account}:parameter/PORT`
            }
        ],
        memoryReservation: 256,
        stopTimeout: 2,
        startTimeout: 2,
        workingDirectory: "/usr/src/app",
        essential: true,
        pseudoTerminal: true,
        cpu: 256,
        memory: 256
    }
}, {
    dependsOn: [DB_NAME, DB_HOST, DB_USER, DB_PASS, PORT, lb],
});

const lambdaRole = new aws.iam.Role("lambdaRole", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: "lambda.amazonaws.com" }),
});

const lambdaRolePolicy = new aws.iam.RolePolicy("lambdaRolePolicy", {
    role: lambdaRole.id,
    policy: {
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow",
            Action: [
                "*",
            ],
            Resource: "*",
        }],
    },
});

const services = [
    "resetCases",
    "parseInvalidCharacters",
    "parseFootnotes",
    "parseEmptyCitations",
    "parseCourts",
    "parseCaseToCase",
    "parseLegislationToCases",
];

let lambdas = [];

const repository = new awsx.ecr.Repository("parser_cloud", {
    name: "parser_cloud",
});

services.map((name) => {
    const cluster = new awsx.ecs.Cluster(name, {
        name: name,
    });

    const asg = cluster.createAutoScalingGroup(name, {
        templateParameters: { minSize: 1,  },
        launchConfigurationArgs: { instanceType: "t2.medium" },
        subnetIds: vpc.publicSubnetIds
    });


    const service = taskDefinition.createService(name, {
        name: `openlawnz-ecs-service`,
        desiredCount: 1,
        waitForSteadyState: true,
        deploymentMinimumHealthyPercent: 100,
        deploymentMaximumPercent: 200,
        schedulingStrategy: "REPLICA",
        securityGroups: [DockerSecurity],
        cluster: cluster,
    });


    const lambda = new aws.lambda.CallbackFunction(name, {
        role: lambdaRole,
        runtime: "nodejs12.x",
        callback: (event, context, callback) => {
            const AWS = require("aws-sdk");
            const ssm = new AWS.SSM();
            console.log("\n\nLoading handler\n\n");
            console.log(event);
            // @ts-ignore
            const instanceId =event["detail"]["ec2InstanceId"];
            console.log("sending command to ssm");
            ssm.sendCommand(
                {
                    DocumentName: "AWS-RunShellScript",
                    InstanceIds: [instanceId],
                    TimeoutSeconds: 3600,
                    Parameters: {
                        "commands": [
                            "#!/bin/bash",
                            "containerID=$(docker ps -qf label=name=openlawnz | xargs)",
                            'if [ -z "$containerID" ]; then',
                            "echo $containerID",
                            'echo "container found"',
                            'sudo docker exec -i ${containerID} bash &lt; /home/ec2-user/test.sh',
                            'fi',
                            'echo "terminating"'
                        ]
                    }
                },
                // @ts-ignore
                function(err, data) {
                    if (err) {
                        console.log(err, err.stack); // an error occurred
                    } else {
                        console.log(data);
                        console.log("successful")
                        // @ts-ignore
                        context.done(null, 'Function Finished!');
                    }
                });
        }});

    lambdas.push(lambda.arn);
});

const sfnRole = new aws.iam.Role("sfnRole", {
    assumeRolePolicy: aws.iam.assumeRolePolicyForPrincipal({ Service: `states.${region}.amazonaws.com` }),
});

const dbProcessor = new aws.sfn.StateMachine("db-processor", {
    roleArn: sfnRole.arn,
    definition: pulumi.all(lambdas).apply((lambdas) => {
        const [ResetCases, ParseInvalidCharacters, ParseFootnotes, ParseEmptyCitations, ParseCourts, ParseCaseToCase, ParseLegislationToCases] = lambdas;
        return JSON.stringify(
            {
                "Comment": "DB Processing",
                "StartAt": "resetCases",
                "States": {
                    "resetCases": {
                        "Type": "Task",
                        "Resource": ResetCases,
                        "Next": "parseInvalidCharacters"
                    },
                    "parseInvalidCharacters": {
                        "Type": "Task",
                        "Resource": ParseInvalidCharacters,
                        "Next": "parallelGroup1"
                    },
                    "parallelGroup1": {
                        "Type": "Parallel",
                        "Next": "parallelGroup2",
                        "Branches": [{
                            "StartAt": "parseFootnotes",
                            "States": {

                                "parseFootnotes": {
                                    "Type": "Task",
                                    "Resource": ParseFootnotes,
                                    "End": true
                                }
                            }
                        },
                                     {
                                         "StartAt": "parseEmptyCitations",
                                         "States": {
                                             "parseEmptyCitations": {
                                                 "Type": "Task",
                                                 "Resource": ParseEmptyCitations,
                                                 "End": true
                                             }
                                         }
                                     }
                                    ]
                    },
                    "parallelGroup2": {
                        "Type": "Parallel",
                        "End": true,
                        "Branches": [{
                            "StartAt": "parseCourts",
                            "States": {
                                "parseCourts": {
                                    "Type": "Task",
                                    "Resource": ParseCourts,
                                    "End": true
                                }
                            }
                        },
                                     {
                                         "StartAt": "parseCaseToCase",
                                         "States": {
                                             "parseCaseToCase": {
                                                 "Type": "Task",
                                                 "Resource": ParseCaseToCase,
                                                 "End": true
                                             }
                                         }
                                     },
                                     {
                                         "StartAt": "parseLegislationToCases",
                                         "States": {
                                             "parseLegislationToCases": {

                                                 "Type": "Task",
                                                 "Resource": ParseLegislationToCases,
                                                 "End": true
                                             }
                                         }
                                     }
                                    ]
                    }
                }
            });});
});


const triggerStepFunctions = new aws.lambda.CallbackFunction("triggerStepFunctions", {
    role: lambdaRole,
    runtime: "nodejs12.x",
    callback: async (event, context, callback) => {
        const AWS = require('aws-sdk');
        const stepFunctions = new AWS.StepFunctions({
            region: region
        });
        const params = {
            stateMachineArn: dbProcessor.arn,
            input: JSON.stringify(event)
        };
        stepFunctions.startExecution(params, (err, data) => {
            if (err) {
                console.log(err.stack);
                const response = {
                    statusCode: 500,

                    body: JSON.stringify({
                        message: 'There was an error'
                    })
                };
                console.log(response);
            } else {
                console.log(data);
                const response = {
                    statusCode: 200,
                    body: JSON.stringify({
                        message: 'Step function worked'
                    }),
                };
                console.log(response);
            }
        });
    }});
