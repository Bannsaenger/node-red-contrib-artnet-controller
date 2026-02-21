class LinearTransition {

    /**
     * Compute single step for linear curve transition
     * @param {number} startValue - value where the transition starts
     * @param {number} targetValue - value to which compute values/steps
     * @param {number} stepCount - count of steps in transition
     * @param {number} currentStep - current step in transition
     * @returns {number} value for current step
     */
    computeValue (startValue, targetValue, stepCount, currentStep) {
        // should we fade up or down?
        const valuePerStep = (targetValue - startValue) / stepCount;
        const currentValue = (valuePerStep * currentStep) + startValue

        return Math.round(currentValue)
    }

    /**
     * Compute steps for linear curve transition
     * @param {number} duration - duration of transition
     * @param {number} stepCount - count of steps in transition
     * @param {number} oldValue - value where the transition starts
     * @param {number} newValue - value to which compute values/steps
     * @returns values for all steps
     */
    computeValues (duration, stepCount, oldValue, newValue) {
        const steps = []

        // should we fade up or down?
        const valuePerStep = (newValue - oldValue) / stepCount;
        const stepDuration = duration / stepCount;

        for (let i = 1; i <= stepCount; i++) {
            const iterationValue = oldValue + i * valuePerStep;

            steps[i] = {
                'value' : Math.round(iterationValue),
                'time' : i * stepDuration,
                'step' : i
            };
        }
        return steps
    }
    
}

class GammaTransition {

    constructor(gammaFactor = 2.2) {
        this.gammaFactor = gammaFactor
    }

    /**
     * Compute single step for gamma curve transition. Gamma curve takes advantage of human perception 
     * @param {number} startValue - value where the transition starts
     * @param {number} targetValue - value to which compute values/steps
     * @param {number} stepCount - count of steps in transition
     * @param {number} currentStep - current step in transition
     * @param {number} [gammaFactor] - if you want another gamma
     * @returns {number} value for current step
     */
    computeValue (startValue, targetValue, stepCount, currentStep, gammaFactor = 2.2) {

        // Apply gamma-like interpolation to make the transition non-linear
        const gammaProgress = Math.pow(currentStep / stepCount, gammaFactor);

        // Interpolate between oldValue and newValue based on the gamma progress
        const interpolatedValue = startValue + (targetValue - startValue) * gammaProgress;

        return Math.round(interpolatedValue)
    }

    /**
     * Compute all steps for gamma curve transition. Gamma curve takes advantage of human perception 
     * of changes in intensity in higher brightness values.
     * @param {number} duration - duration of transition
     * @param {number} stepCount - count of steps in transition
     * @param {number} oldValue - value where the transition starts
     * @param {number} newValue - value to which compute values/steps
     * @returns values for all steps
     */
    computeValues (duration, stepCount, oldValue, newValue) {
        const steps = [];

        const stepDuration = duration / stepCount;

        for (let i = 0; i <= stepCount; i++) {
            // Normalize the time to a value between 0 and 1 based on the step's progress
            const stepProgress = i / stepCount;

            // Apply gamma-like interpolation to make the transition non-linear
            const gammaProgress = Math.pow(stepProgress, this.gammaFactor);

            // Interpolate between oldValue and newValue based on the gamma progress
            const interpolatedValue = oldValue + (newValue - oldValue) * gammaProgress;

            steps[i] = {
                'value' : Math.round(interpolatedValue),
                'time' : i * stepDuration,
                'step' : i
            };
        }

        return steps;
    }    
}

class QuadraticTransition {

    /**
     * Compute single step for gamma curve transition. Gamma curve takes advantage of human perception 
     * @param {number} startValue - value where the transition starts
     * @param {number} targetValue - value to which compute values/steps
     * @param {number} stepCount - count of steps in transition
     * @param {number} currentStep - current step in transition
     * @returns {number} value for current step
     */
    computeValue (startValue, targetValue, stepCount, currentStep) {

        // Normalize the step to a value between 0 and 1
        const stepProgress = currentStep / stepCount;

        // Apply quadratic interpolation (slow-to-fast)
        const quadraticProgress = stepProgress * stepProgress;

        // Interpolate between oldValue and newValue based on the gamma progress
        const interpolatedValue = startValue + (targetValue - startValue) * quadraticProgress;

        return Math.round(interpolatedValue)
    }

    /**
     * Compute all steps for quadratic curve transition.
     * @param {number} duration - duration of transition
     * @param {number} stepCount - count of steps in transition
     * @param {number} oldValue - value where the transition starts
     * @param {number} newValue - value to which compute values/steps
     * @returns values for all steps
     */
    computeValues (duration, stepCount, oldValue, newValue) {
        const steps = [];

        const stepDuration = duration / stepCount;

        for (let i = 0; i <= stepCount; i++) {
            // Normalize the step to a value between 0 and 1
            const stepProgress = i / stepCount;

            // Apply quadratic interpolation (slow-to-fast)
            const quadraticProgress = stepProgress * stepProgress;

            // Interpolate between oldValue and newValue based on the quadratic progress
            const interpolatedValue = oldValue + (newValue - oldValue) * quadraticProgress;

            steps[i] = {
                'value' : Math.round(interpolatedValue),
                'time' : i * stepDuration,
                'step' : i
            };
        }

        return steps;
    }
    
}

class SineTransition {

    /**
     * Compute single steps for sine curve transition
     * @param {number} startValue - value where the transition starts
     * @param {number} targetValue - value to which compute values/steps
     * @param {number} stepCount - count of steps in transition
     * @param {number} currentStep - current step in transition
     * @returns {number} value for current step
     */
    computeValue (startValue, targetValue, stepCount, currentStep) {

        // Normalize the step to a value between 0 and PI
        const stepProgress = (currentStep / stepCount) * Math.PI;

        // Apply sine starting at -PI/2 elevated by 1 and then half to have values from 0 to 1
        const sineProgress = (Math.sin(stepProgress - (Math.PI / 2)) + 1) / 2;

        // Interpolate between oldValue and newValue based on the sine progress
        const interpolatedValue = startValue + (targetValue - startValue) * sineProgress;

        return Math.round(interpolatedValue)
    }

    /**
     * Compute all steps for sine curve transition
     * @param {number} duration - duration of transition
     * @param {number} stepCount - count of steps in transition
     * @param {number} oldValue - value where the transition starts
     * @param {number} newValue - value to which compute values/steps
     * @returns values for all steps
     */
    computeValues (duration, stepCount, oldValue, newValue) {
        const steps = [];

        const stepDuration = duration / stepCount;

        // get the radians per step based on 90 degrees per trsansaction
        const radPerStep = (90 / stepCount) * Math.PI / 180;

        for (let i = 0; i <= stepCount; i++) {
            steps[i] = {
                'value' : Math.round(Math.sin(radPerStep * i) * newValue),
                'time' : i * stepDuration,
                'step' : i
            };
        }

        return steps;
    }
    
}

/**
 * 
 * @param {string} type 
 * @returns 
 */
module.exports.TransitionFactory = function(type) {
    switch (type) {
        case 'linear':
            return new LinearTransition();
        case 'gamma':
            return new GammaTransition();
        case 'quadratic':
            return new QuadraticTransition();
        case 'sine':
            return new SineTransition();
        default:
            throw new Error("Unknown transtition type: " + type);
    }
}
