#!/usr/bin/env node
'use strict';

/**
 * This script is design for FortiGate Autoscale project
 * It updates the templates to add support for a specific product version(s)
 */

const OS = require('os');
const FS = require('fs');
const PATH = require('path');
const COMMANDER = require('commander');
const SHELL = require('shelljs');
const SEMVER = require('semver');

const ROOT_DIR = PATH.normalize(`${__dirname}`);
const CACHE_FILE_PATH = PATH.resolve(OS.tmpdir(), 'autoscale-ci-aws-product-images.json');
const CACHE_DEFAULT_TTL = 1800000;
const MODEL_PAYG = 'PAYG',
    MODEL_BYOL = 'BYOL';
const PRODUCT_CODE_ALL = 'all';
const PRODUCT_CODE_FORTIGATE = 'fortigate',
    PRODUCT_CODE_FORTIANALYZER = 'fortianalyzer';
const readFileAsJson = (filePath, showLog = true) => {
    try {
        return JSON.parse(FS.readFileSync(filePath, 'utf8'));
    } catch (error) {
        if (showLog) {
            console.error(error);
        }
        return null;
    }
};
const saveJsonToFile = (filePath, json, showLog = true) => {
    FS.writeFileSync(filePath, JSON.stringify(json, null, 4));
    if (showLog) {
        console.info(`File is saved: ${filePath}`);
    }
};

let CACHE_IMAGES,
    CACHE_LOCAL_STORAGE = true,
    CACHE_TTL = CACHE_DEFAULT_TTL;

const initAWSCLI = command => {
    process.env.AWS_ACCESS_KEY_ID = String(command.accessKeyId).trim();
    process.env.AWS_SECRET_ACCESS_KEY = String(command.secretAccessKey).trim();
    process.env.AWS_DEFAULT_REGION = String(command.awsRegion).trim();
    process.env.AWS_DEFAULT_OUTPUT = 'json';
};

const updateTreeNodeRecursive = (tree, nodePath, value) => {
    const nodes = String(nodePath).split('.') || [];
    if (nodes.length > 0) {
        const nodeName = nodes.shift();
        if (!tree[nodeName]) {
            console.error(`Node '${nodeName}' not found in the nodePath.`);
        } else if (nodes.length > 0) {
            // recursion
            tree[nodeName] = updateTreeNodeRecursive(tree[nodeName], nodes.join('.'), value);
        } else {
            tree[nodeName] = value;
        }
    }
    return tree;
};

const getTreeNodeValue = (tree, nodePath) => {
    const nodes = String(nodePath).split('.') || [];
    for (let node of nodes) {
        if (tree[node]) {
            tree = tree[node];
        } else {
            return tree;
        }
    }
    return tree;
};

const listImages = async (region, filters = []) => {
    let filterString =
        (Array.isArray(filters) &&
            filters
                .map(filter => {
                    return `"Name=${filter.key},Values=${filter.value}"`;
                })
                .join(' ')) ||
        null;
    filterString = (filterString && `--filters ${filterString}`) || '';
    const query = `aws ec2 describe-images ${filterString} --region ${region}`;
    return await new Promise(resolve => {
        SHELL.exec(query, { silent: true }, (code, stdout, stderr) => {
            try {
                if (code !== 0) {
                    throw new Error(stderr);
                }
                resolve(JSON.parse(stdout));
            } catch (error) {
                console.log('error in query: ', query);
                console.error(error);
                resolve({ Images: [] });
            }
        });
    });
};

const resetImageLocalCache = () => {
    saveJsonToFile(CACHE_FILE_PATH, { ttl: 0, content: {} }, false);
};

const saveImageToCache = (
    product,
    region,
    image,
    localStorage = false,
    ttl = CACHE_DEFAULT_TTL
) => {
    if (!CACHE_IMAGES) {
        CACHE_IMAGES = { ttl: Date.now() + ttl, content: {} };
    }
    if (!CACHE_IMAGES.content[product]) {
        CACHE_IMAGES.content[product] = {};
    }
    if (!CACHE_IMAGES.content[product][region]) {
        CACHE_IMAGES.content[product][region] = {};
    }
    if (!CACHE_IMAGES.content[product][region][image.version]) {
        CACHE_IMAGES.content[product][region][image.version] = {};
    }
    if (!CACHE_IMAGES.content[product][region][image.version][image.model]) {
        CACHE_IMAGES.content[product][region][image.version][image.model] = image;
    }
    if (localStorage) {
        CACHE_IMAGES.ttl = Date.now() + ttl;
        saveJsonToFile(CACHE_FILE_PATH, CACHE_IMAGES, false);
    }
    return true;
};

const loadImageFromCache = (product, region, version, model) => {
    if (!CACHE_IMAGES && CACHE_LOCAL_STORAGE) {
        CACHE_IMAGES = readFileAsJson(CACHE_FILE_PATH, false);
        if (!CACHE_IMAGES || CACHE_IMAGES.ttl < Date.now()) {
            CACHE_IMAGES = null;
            return CACHE_IMAGES;
        }
    }
    return (
        (CACHE_IMAGES &&
            CACHE_IMAGES.content &&
            CACHE_IMAGES.content[product] &&
            CACHE_IMAGES.content[product][region] &&
            CACHE_IMAGES.content[product][region][version] &&
            CACHE_IMAGES.content[product][region][version][model]) ||
        null
    );
};

const getCacheTTL = () => {
    let ttl = CACHE_IMAGES.ttl - Date.now();
    return (CACHE_LOCAL_STORAGE && ttl > 0 && ttl) || 0;
};

const getProductImages = async (productCode, amiFinder, region, versions, model) => {
    model = (model === MODEL_BYOL && MODEL_BYOL) || MODEL_PAYG;
    if (!Array.isArray(versions)) {
        return [];
    }
    let images = [];
    for (let v of versions) {
        let img = loadImageFromCache(productCode, region, v, model);
        if (!img) {
            const result = await listImages(region, [
                {
                    key: amiFinder.keyName,
                    value: amiFinder.keyPattern
                },
                {
                    key: "is-public",
                    value: "true"
                }
            ]);
            img = result.Images.map(i => {
                try {
                    const [, m, v1] = new RegExp(amiFinder.modelPattern, 'gim').exec(i.Name) || [
                        null,
                        null,
                        null
                    ];
                    const image = {
                        model: (m === amiFinder.modelMatching.payg && MODEL_PAYG) || MODEL_BYOL,
                        version: v1 || null,
                        image: i || null
                    };
                    saveImageToCache(productCode, region, image, CACHE_LOCAL_STORAGE, CACHE_TTL);
                    return image;
                } catch (error) {
                    console.error(error);
                    return {
                        model: null,
                        version: null,
                        image: null
                    };
                }
            }).find(fi => {
                return fi.version && versions.includes(fi.version) && fi.model === model;
            });
            if (!img) {
                console.error(
                    `cannot find AMI from AWS region ${region} for: ` +
                        `product: ${productCode}, version: ${v}, model: ${model}. skipped it.`
                );
                return;
            }
        }
        images.push(loadImageFromCache(productCode, region, v, model));
    }
    console.info(
        `${images.length} images loaded. region: ${region}, ` +
            `product: ${productCode}, version: [${versions.join(', ')}], ` +
            `model: ${model}.` +
            `${(CACHE_LOCAL_STORAGE && ` cache ttl: ${getCacheTTL()} ms.`) || ''}`
    );
    return images;
};

const getVersionNum = version => {
    const v = SEMVER.valid(SEMVER.coerce(version));
    if (!v) {
        throw new Error(`${version} isn't a valid semver.`);
    }
    return v.replace(/\./g, '');
};

const updateKeyMap = (map, versions, keyPattern) => {
    if (Array.isArray(versions)) {
        versions.forEach(v => {
            let versionNum = getVersionNum(v);
            map[versionNum] = keyPattern.replace(/\${versionNum}/g, versionNum);
        });
    }
    return map;
};

const updateAmiRegionMap = (map, keyMap, product, versions, regions, model) => {
    for (let r of regions) {
        for (let v of versions) {
            let versionNum = getVersionNum(v);
            let k = keyMap[versionNum];
            const i = loadImageFromCache(product, r, v, model);
            if (!i) {
                console.error(
                    'ERROR: the following AMI Id cannot be found!' +
                        ' You should not include it in this script for automation.' +
                        ' Please ensure the availability of AMI Id for' +
                        ` product: ${product} in region: ${r} , version: [${v}], model: [${model}].`
                );
            }
            // update the AMI source
            if (!map.AMI) {
                map.AMI = {};
            }
            map.AMI[k] = (i && i.image.ImageLocation) || '';
            if (!map[r]) {
                map[r] = {};
            }
            map[r][k] = (i && i.image.ImageId) || '';
        }
    }
    return map;
};

const updateTemplate = async (
    templateDir,
    taskDefinitions,
    product,
    versions,
    defaultVersion = 'LATEST'
) => {
    let sortedVersions = Array.isArray(versions) && versions.sort().reverse();
    let templateJSON,
        templateName = null;
    let promises = taskDefinitions.map(async task => {
        if (task.product !== PRODUCT_CODE_ALL && task.product !== product) {
            console.log(`product not match, skipped task: ${task.name}\n`);
            return true;
        }
        if (task.templateName && task.templateName !== templateName) {
            // if template is processing, save it and process another one
            if (templateName) {
                if (templateJSON) {
                    saveJsonToFile(PATH.resolve(templateDir, templateName), templateJSON);
                }
                templateName = null;
            }

            if (!templateName) {
                templateName = task.templateName;
                templateJSON = readFileAsJson(PATH.resolve(templateDir, task.templateName));
            }
        }
        console.info(`\nRunning task: ${task.name}\n`);
        let newNodeValue, model, keyMap, regionMap;
        switch (task.type) {
            case 'parameter':
                newNodeValue = getTreeNodeValue(templateJSON, task.nodePath);
                newNodeValue.AllowedValues = sortedVersions;
                newNodeValue.Default =
                    (versions.includes(defaultVersion) && defaultVersion) ||
                    sortedVersions[0] ||
                    null;
                if (newNodeValue.Default === null) {
                    delete newNodeValue.Default;
                }
                templateJSON = updateTreeNodeRecursive(templateJSON, task.nodePath, newNodeValue);
                break;
            case 'ami':
                model = String(task.model).toLocaleUpperCase();
                model = (model === MODEL_BYOL && MODEL_BYOL) || MODEL_PAYG;
                // update version key map
                keyMap = getTreeNodeValue(templateJSON, task.keyPath);
                keyMap = updateKeyMap(keyMap, versions, task.keyPattern);
                // save updated keyMap to template JSON
                templateJSON = updateTreeNodeRecursive(templateJSON, task.keyPath, keyMap);
                // list all available images
                for (let region of task.regions) {
                    await getProductImages(
                        (task.product === PRODUCT_CODE_FORTIGATE && PRODUCT_CODE_FORTIGATE) ||
                            PRODUCT_CODE_FORTIANALYZER,
                        task.amiFinder,
                        region,
                        versions,
                        model
                    );
                    // console.log(images);
                }
                // update ami regarding version key
                regionMap = getTreeNodeValue(templateJSON, task.mapPath);
                regionMap = await updateAmiRegionMap(
                    regionMap,
                    keyMap,
                    task.product,
                    versions,
                    task.regions,
                    (model === MODEL_BYOL && MODEL_BYOL) || MODEL_PAYG
                );
                templateJSON = updateTreeNodeRecursive(templateJSON, task.mapPath, regionMap);
                break;
            default:
                break;
        }
    });
    await Promise.all(promises);
    if (templateName && templateJSON) {
        saveJsonToFile(PATH.resolve(templateDir, templateName), templateJSON);
    }
    return;
};

const run = async command => {
    let prodVers;
    let tasks;
    let templateDir;
    const operation = ['add', 'delete'].includes(command.operation) || null;
    if (!operation) {
        throw new Error(`unknown operation: ${command.operation}`);
    }
    initAWSCLI(command);
    CACHE_TTL = (command.cacheTtl && Number(command.cacheTtl)) || CACHE_DEFAULT_TTL;
    CACHE_LOCAL_STORAGE = command.cache;
    if (command.resetCache) {
        resetImageLocalCache();
    }

    tasks = readFileAsJson(PATH.resolve(ROOT_DIR, command.taskFile));
    templateDir = PATH.resolve(ROOT_DIR, command.directory);

    if (command.productVersion) {
        prodVers = command.productVersion.split(' ').map(pv => {
            const [prod, vers] = pv.split('=');
            return {
                product: prod,
                versions: vers.split(',')
            };
        });
    } else {
        let products = [];
        if (!command.product || command.product === PRODUCT_CODE_FORTIGATE) {
            products.push(PRODUCT_CODE_FORTIGATE);
        }
        if (!command.product || command.product === PRODUCT_CODE_FORTIANALYZER) {
            products.push(PRODUCT_CODE_FORTIANALYZER);
        }
        prodVers = products.map(product => {
            return {
                product: product,
                versions: command.targetVersion.split(' ')
            };
        });
    }

    for (let p of prodVers) {
        await updateTemplate(templateDir, tasks, p.product, p.versions, '6.2.3');
    }
};

const program = new COMMANDER.Command();

const main = async () => {
    await program.parseAsync(process.argv);
    console.log('program ends.');
};

program
    .description('Pull AMI Ids from AWS and update them to target templates.')
    .option(
        '-o, --operation <type>',
        'actions for automation. accepted values: add (default) | delete',
        'add'
    )
    .option('-A, --add', 'alias for action --action add')
    .option('-D, --delete', 'alias for action --action delete')
    .requiredOption('-d, --directory <dir>', 'template directory')
    .requiredOption('-t, --task-file <file>', 'A task definition file.')
    .requiredOption(
        '-k, --access-key-id <value>',
        'provided access key id for a programatic IAM user access to AWS'
    )
    .requiredOption(
        '-s, --secret-access-key <value>',
        'provided secret access key for a programatic IAM user access to AWS'
    )
    .option(
        '-p, --product <value>',
        'a single product code. accepted values: fortigate|fortianalyzer'
    )
    .requiredOption(
        '-n, --target-version <list>',
        'A list of target versions. Each specified version is of semver style version num. Each specifed version is separated by a white space.'
    )
    .option(
        '-e, --product-version <list>',
        'A list of product-version pairs. Each specifed pairs is separated by a white space. Example: -e fortigate=0.0.1,0.0.2,0.0.3 fortianalyzer=0.0.4,0.0.5,0.0.6'
    )
    .option(
        '--no-cache',
        'with this argument to NOT cache Images info from AWS to local file system.'
    )
    .option('--reset-cache', 'reset the local cache for Images info from AWS.')
    .option(
        '--cache-ttl <ms>',
        'time to live (ms) of cache of Images info from AWS stored in local file system. Default 1800000'
    )
    .action(run);

main();
