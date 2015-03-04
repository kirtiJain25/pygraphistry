var Kernel = require('../kernel.js'),
    Q = require('q'),
    debug = require("debug")("graphistry:graph-viz:cl:barensKernels"),
    _     = require('underscore'),
    cljs  = require('../cl.js');
    ArgsType = require('./ArgsType.js');

var edgeKernelSeqFast = function (clContext) {

    this.argsMapEdges = [
    'scalingRatio', 'gravity', 'edgeInfluence', 'flags', 'edges', 'numEdges',
    'workList', 'inputPoints', 'stepNumber', 'numWorkItems', 'outputForcesMap'
];

    this.argsSegReduce = [
        'scalingRatio', 'gravity', 'edgeInfluence', 'flags', 'numInput', 'input',
        'edgeStartEndIdxs', 'segStart', 'workList', 'numOutput', 'carryOutGlobal', 'output', 'partialForces'];


    this.mapEdges = new Kernel('faEdgeMap', this.argsMapEdges, ArgsType, 'forceAtlas2.cl', clContext);

    this.segReduce = new Kernel("segReduce", this.argsSegReduce,
                                ArgsType, 'segReduce.cl', clContext);


    this.kernels = [this.mapEdges, this.segReduce];

    this.setPhysics = function(cfg, mask) {
        _.each(this.kernels, function (k) {
            k.set(_.pick(cfg, k.argNames))
        })
        this.mapEdges.set({flags: mask});
        this.segReduce.set({flags: mask});
    };

    this.tempBuffers = {
      outputEdgeForcesMap: null,
      globalCarryOut: null,
      forwardsEdgeStartEndIdxs: null,
      backwardsEdgeStartEndIdxs: null,
      segStart: null
    }

    this.setEdges = function(simulator, layoutBuffers) {
      var forwardsEdges = simulator.bufferHostCopies.forwardsEdges;
      var backwardsEdges = simulator.bufferHostCopies.backwardsEdges;
      var that = this;
        return Q.all([
            simulator.cl.createBuffer(forwardsEdges.edgesTyped.byteLength, 'outputEdgeForcesMap'),
            simulator.cl.createBuffer(1 + Math.ceil(simulator.numEdges / 256), 'globalCarryIn'),
            simulator.cl.createBuffer(forwardsEdges.edgeStartEndIdxsTyped.byteLength, 'forwardsEdgeStartEndIdxs'),
            simulator.cl.createBuffer(backwardsEdges.edgeStartEndIdxsTyped.byteLength, 'backwardsEdgeStartEndIdxs'),
            simulator.cl.createBuffer((simulator.numPoints * Float32Array.BYTES_PER_ELEMENT) / 2, 'segStart')])
    .spread(function(outputEdgeForcesMap, globalCarryOut, forwardsEdgeStartEndIdxs, backwardsEdgeStartEndIdxs,
                     segStart) {
        // Bind buffers
        that.tempBuffers.outputEdgeForcesMap = outputEdgeForcesMap;
        that.tempBuffers.globalCarryOut = globalCarryOut;
        that.tempBuffers.forwardsEdgeStartEndIdxs = forwardsEdgeStartEndIdxs;
        that.tempBuffers.backwardsEdgeStartEndIdxs = backwardsEdgeStartEndIdxs;
        that.tempBuffers.segStart = segStart;
        return Q.all([
            that.tempBuffers.forwardsEdgeStartEndIdxs.write(forwardsEdges.edgeStartEndIdxsTyped),
            that.tempBuffers.backwardsEdgeStartEndIdxs.write(backwardsEdges.edgeStartEndIdxsTyped)
        ]);
    })
    };

    this.execKernels = function(simulator, forwardsEdges, forwardsWorkItems, numForwardsWorkItems,
                                backwardsEdges, backwardsWorkItems, numBackwardsWorkItems, points,
                                stepNumber) {
      var buffers = simulator.buffers;
      var that = this;
      return this.edgeForcesOneWay(simulator, forwardsEdges, forwardsWorkItems, numForwardsWorkItems,
          buffers.curPoints, stepNumber, buffers.partialForces1, buffers.partialForces2, this.tempBuffers.forwardsEdgeStartEndIdxs)
        .then(function () {
          return that.edgeForcesOneWay(simulator, backwardsEdges, backwardsWorkItems, numBackwardsWorkItems,
              buffers.curPoints, stepNumber, buffers.partialForces2, buffers.curForces, that.tempBuffers.backwardsEdgeStartEndIdxs);
        });
        }


    this.edgeForcesOneWay = function(simulator, edges, workItems, numWorkItems,
        points, stepNumber, partialForces, outputForces, startEnd) {
      this.mapEdges.set({
        numEdges: simulator.numEdges,
        edges: edges.buffer,
        workList: workItems.buffer,
        inputPoints: points.buffer,
        stepNumber: stepNumber,
        numWorkItems: numWorkItems,
        outputForcesMap: simulator.buffers.outputEdgeForcesMap.buffer
      });

      var resources = [edges, workItems, points, partialForces, outputForces];

      simulator.tickBuffers(
          _.keys(simulator.buffers).filter(function (name) {
            return simulator.buffers[name] == outputForces;
          })
          );

      debug("Running kernel faEdgeForces");
      var that = this;
      return this.mapEdges.exec([100*256], resources, [256]).then(function () {
        that.segReduce.set({
          edgeStartEndIdxs: startEnd.buffer,
          input: simulator.buffers.outputEdgeForcesMap.buffer,
          segStart: simulator.buffers.segStart.buffer,
          numInput:simulator.numEdges,
          numOutput:simulator.numPoints,
          workList: workItems.buffer,
          output: outputForces.buffer,
          partialForces:partialForces.buffer,
          carryOutGlobal: simulator.buffers.globalCarryOut.buffer
        })

        return that.segReduce.exec([2000*256], resources, [256]);
      })

    }
}

module.exports = edgeKernelSeqFast;
